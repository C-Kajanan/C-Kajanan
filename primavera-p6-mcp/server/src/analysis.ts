// Schedule analysis over a parsed XER project: summaries, filters, critical
// and driving paths, DCMA 14-point health check, look-aheads and update
// comparisons. Durations and floats are in working days of each activity's
// calendar; dates are as P6 exported them.

import {
  brief,
  DAY,
  HARD_CONSTRAINTS,
  HOUR,
  isComplete,
  isMilestone,
  isSummaryType,
  round,
  type Activity,
  type Relationship,
  type Schedule,
} from "./schedule.js";
import { parseDate, table } from "./xer.js";

const pct = (n: number, d: number) => (d === 0 ? 0 : round((n / d) * 100, 1));
const byStart = (a: Activity, b: Activity) =>
  (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity) || a.id.localeCompare(b.id);

/** Activity that finishes last; on a tie, prefer a finish milestone, then one without successors. */
export function latestFinish(acts: Activity[]): Activity | undefined {
  const rank = (a: Activity) => (a.type === "Finish Milestone" ? 2 : 0) + (a.succs.length === 0 ? 1 : 0);
  let best: Activity | undefined;
  for (const a of acts) {
    if (a.finishMs === undefined) continue;
    if (!best || a.finishMs > best.finishMs! || (a.finishMs === best.finishMs && rank(a) > rank(best))) best = a;
  }
  return best;
}

function earliestStart(acts: Activity[]): Activity | undefined {
  let best: Activity | undefined;
  for (const a of acts) if (a.startMs !== undefined && (!best || a.startMs < best.startMs!)) best = a;
  return best;
}

export function summary(s: Schedule, criticalFloatDays = 0) {
  const acts = s.activities;
  const count = (f: (a: Activity) => boolean) => acts.filter(f).length;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const a of acts) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    byType[a.type] = (byType[a.type] ?? 0) + 1;
  }
  const work = acts.filter((a) => !isSummaryType(a));
  const totalOrig = work.reduce((n, a) => n + a.originalDurationDays, 0);
  const earned = work.reduce((n, a) => n + a.originalDurationDays * (a.percentComplete / 100), 0);
  const finishAct = latestFinish(acts);
  const startAct = earliestStart(acts);
  const cost = acts.flatMap((a) => a.assignments).reduce(
    (t, r) => ({ planned: t.planned + r.plannedCost, actual: t.actual + r.actualCost, remaining: t.remaining + r.remainingCost }),
    { planned: 0, actual: 0, remaining: 0 },
  );
  return {
    file: s.xer.path,
    p6Version: s.xer.version,
    exportDate: s.xer.exportDate,
    project: { code: s.projectCode, name: s.projectName },
    dataDate: s.dataDate,
    plannedStart: s.plannedStart,
    mustFinishBy: s.mustFinishBy,
    scheduledFinish: s.scheduledFinish,
    start: startAct?.start,
    finish: finishAct?.finish,
    finishActivity: finishAct ? { id: finishAct.id, name: finishAct.name } : undefined,
    activities: acts.length,
    relationships: s.relationships.length,
    wbsElements: [...s.wbs.values()].filter((w) => !w.isProjectNode).length,
    byStatus,
    byType,
    durationWeightedPercentComplete: pct(earned, totalOrig),
    critical: count((a) => !isComplete(a) && (a.totalFloatDays ?? Infinity) <= criticalFloatDays),
    negativeFloat: count((a) => !isComplete(a) && (a.totalFloatDays ?? 0) < 0),
    longestPath: count((a) => a.longestPath),
    resourceAssignments: acts.reduce((n, a) => n + a.assignments.length, 0),
    cost: s.hasResources ? { planned: round(cost.planned), actual: round(cost.actual), remaining: round(cost.remaining) } : undefined,
  };
}

export interface ActivityFilter {
  status?: ("Not Started" | "In Progress" | "Completed")[];
  types?: string[];
  wbs?: string;
  search?: string;
  maxFloat?: number;
  minFloat?: number;
  longestPathOnly?: boolean;
  startsAfter?: string;
  finishesBefore?: string;
  hasConstraint?: boolean;
  resource?: string;
}

export function filterActivities(s: Schedule, f: ActivityFilter): Activity[] {
  const startsAfter = parseDate(f.startsAfter);
  const finishesBefore = parseDate(f.finishesBefore);
  const search = f.search?.toLowerCase();
  const wbs = f.wbs?.toLowerCase();
  const resource = f.resource?.toLowerCase();
  const types = f.types?.map((t) => t.toLowerCase());
  return s.activities
    .filter((a) => {
      if (f.status?.length && !f.status.includes(a.status as never)) return false;
      if (types?.length && !types.some((t) => a.type.toLowerCase().includes(t))) return false;
      if (wbs && !a.wbsCode.toLowerCase().startsWith(wbs) && !a.wbsPath.toLowerCase().includes(wbs)) return false;
      if (search && !a.id.toLowerCase().includes(search) && !a.name.toLowerCase().includes(search)) return false;
      if (f.maxFloat !== undefined && !((a.totalFloatDays ?? Infinity) <= f.maxFloat)) return false;
      if (f.minFloat !== undefined && !((a.totalFloatDays ?? -Infinity) >= f.minFloat)) return false;
      if (f.longestPathOnly && !a.longestPath) return false;
      if (startsAfter !== undefined && !((a.startMs ?? -Infinity) >= startsAfter)) return false;
      if (finishesBefore !== undefined && !((a.finishMs ?? Infinity) <= finishesBefore)) return false;
      if (f.hasConstraint !== undefined && Boolean(a.constraintCode) !== f.hasConstraint) return false;
      if (resource && !a.assignments.some((r) => r.resourceId.toLowerCase().includes(resource) || r.resourceName.toLowerCase().includes(resource)))
        return false;
      return true;
    })
    .sort(byStart);
}

export function criticalPath(s: Schedule, floatThreshold = 0, includeCompleted = false) {
  const acts = s.activities
    .filter((a) => (includeCompleted || !isComplete(a)) && !isSummaryType(a))
    .filter((a) => (a.totalFloatDays ?? Infinity) <= floatThreshold || (floatThreshold <= 0 && a.longestPath && !isComplete(a)))
    .sort(byStart);
  return {
    project: s.projectCode,
    dataDate: s.dataDate,
    floatThreshold,
    count: acts.length,
    note: "Activities whose total float is at or below the threshold, plus those P6 flagged as on the longest path, ordered by start.",
    activities: acts.map((a) => ({ ...brief(a), onLongestPath: a.longestPath })),
  };
}

/**
 * Position of a timestamp on a working-day axis. Times after midday count as
 * the end of that day, so a Friday 17:00 finish and the following Monday
 * 08:00 start land on the same position. Holidays are not known from the
 * export and count as working days.
 */
function workPos(ms: number, workDaysPerWeek: number): number {
  const day = Math.floor(ms / DAY);
  const endOfDay = (ms - day * DAY) / HOUR >= 12 ? 1 : 0;
  if (workDaysPerWeek >= 7) return day + endOfDay;
  const fromMonday = day + 3; // 1970-01-01 was a Thursday
  const week = Math.floor(fromMonday / 7);
  const weekday = fromMonday - week * 7; // 0 = Monday
  return week * 5 + Math.min(weekday, 5) + (weekday < 5 ? endOfDay : 0);
}

/**
 * Working days between a predecessor's controlling date (+lag) and the
 * successor's dependent date. The predecessor with the smallest gap is the one
 * driving the successor; 0 means it drives exactly.
 */
function relGap(r: Relationship): number | undefined {
  const { pred, succ } = r;
  const base = r.type === "SS" || r.type === "SF" ? pred.startMs : pred.finishMs;
  const target = r.type === "FF" || r.type === "SF" ? succ.finishMs : succ.startMs;
  if (base === undefined || target === undefined) return undefined;
  const wd = succ.workDaysPerWeek;
  return workPos(target, wd) - workPos(base, wd) - r.lagDays;
}

export function drivingPath(s: Schedule, target: Activity, maxSteps = 500) {
  const path: { activity: Activity; via?: Relationship; gap?: number }[] = [{ activity: target }];
  const seen = new Set([target.taskId]);
  let current = target;
  for (let i = 0; i < maxSteps; i++) {
    if (isComplete(current) || current.actualStart) break; // driven by the data date from here
    let best: { r: Relationship; gap: number } | undefined;
    for (const r of current.preds) {
      if (seen.has(r.pred.taskId)) continue;
      const gap = relGap(r);
      if (gap === undefined) continue;
      if (!best || gap < best.gap) best = { r, gap };
    }
    if (!best) break;
    path[path.length - 1].via = best.r;
    path[path.length - 1].gap = round(best.gap, 2);
    current = best.r.pred;
    seen.add(current.taskId);
    path.push({ activity: current });
  }
  return {
    target: target.id,
    steps: path.length,
    note: "Traced backwards by picking, at each step, the predecessor whose relationship leaves the smallest gap in working days. A gap of 0 means the predecessor drives the successor exactly; a gap of 1 can be a holiday. The trace stops at an activity that has started or has no predecessors.",
    path: path
      .reverse()
      .map(({ activity: a, via, gap }) => ({ ...brief(a), drives: via ? { successor: via.succ.id, type: via.type, lag: via.lagDays, gapDays: gap } : undefined })),
  };
}

export function lookahead(s: Schedule, days: number, from?: string) {
  const fromMs = parseDate(from) ?? s.dataDateMs ?? Date.now();
  const toMs = fromMs + days * DAY;
  const acts = s.activities
    .filter((a) => !isComplete(a) && !isSummaryType(a))
    .filter((a) => (a.startMs ?? Infinity) < toMs && (a.finishMs ?? -Infinity) >= fromMs)
    .sort(byStart);
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    project: s.projectCode,
    window: { from: fmt(fromMs), to: fmt(toMs), days },
    starting: acts.filter((a) => !a.actualStart && (a.startMs ?? Infinity) >= fromMs).length,
    inProgress: acts.filter((a) => a.actualStart).length,
    finishing: acts.filter((a) => (a.finishMs ?? Infinity) < toMs).length,
    activities: acts.map((a) => ({ ...brief(a), resources: a.assignments.map((r) => r.resourceId) })),
  };
}

export function wbsTree(s: Schedule, maxDepth = 10) {
  const children = new Map<string, string[]>();
  for (const w of s.wbs.values()) {
    if (!children.has(w.parentId)) children.set(w.parentId, []);
    children.get(w.parentId)!.push(w.wbsId);
  }
  const actsByWbs = new Map<string, Activity[]>();
  for (const a of s.activities) {
    if (!actsByWbs.has(a.wbsId)) actsByWbs.set(a.wbsId, []);
    actsByWbs.get(a.wbsId)!.push(a);
  }
  type Node = { code: string; name: string; activities: number; start?: string; finish?: string; minFloat?: number; children?: Node[] };
  const all = (id: string): Activity[] => [...(actsByWbs.get(id) ?? []), ...(children.get(id) ?? []).flatMap(all)];
  const build = (id: string, depth: number): Node => {
    const w = s.wbs.get(id)!;
    const acts = all(id);
    const floats = acts.filter((a) => !isComplete(a) && a.totalFloatDays !== undefined).map((a) => a.totalFloatDays!);
    const kids = (children.get(id) ?? []).map((k) => s.wbs.get(k)!).sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));
    return {
      code: w.isProjectNode ? s.projectCode : w.path,
      name: w.name,
      activities: acts.length,
      start: earliestStart(acts)?.start,
      finish: latestFinish(acts)?.finish,
      minFloat: floats.length ? Math.min(...floats) : undefined,
      children: depth < maxDepth && kids.length ? kids.map((k) => build(k.wbsId, depth + 1)) : undefined,
    };
  };
  const root = [...s.wbs.values()].find((w) => w.isProjectNode);
  if (root) return build(root.wbsId, 0);
  return { code: s.projectCode, name: s.projectName, children: [...s.wbs.values()].filter((w) => !s.wbs.has(w.parentId)).map((w) => build(w.wbsId, 1)) };
}

export function resourceSummary(s: Schedule) {
  const totals = new Map<string, { id: string; name: string; type: string; activities: number; planned: number; actual: number; remaining: number; plannedCost: number; actualCost: number; remainingCost: number }>();
  for (const a of s.activities)
    for (const r of a.assignments) {
      const t = totals.get(r.resourceId) ?? { id: r.resourceId, name: r.resourceName, type: r.resourceType, activities: 0, planned: 0, actual: 0, remaining: 0, plannedCost: 0, actualCost: 0, remainingCost: 0 };
      t.activities++;
      t.planned += r.plannedUnits;
      t.actual += r.actualUnits;
      t.remaining += r.remainingUnits;
      t.plannedCost += r.plannedCost;
      t.actualCost += r.actualCost;
      t.remainingCost += r.remainingCost;
      totals.set(r.resourceId, t);
    }
  const list = [...totals.values()].map((t) => ({
    ...t,
    planned: round(t.planned),
    actual: round(t.actual),
    remaining: round(t.remaining),
    plannedCost: round(t.plannedCost),
    actualCost: round(t.actualCost),
    remainingCost: round(t.remainingCost),
  }));
  return {
    project: s.projectCode,
    note: "Units are hours for labor and nonlabor resources and the resource's unit of measure for material.",
    resources: list.sort((a, b) => b.planned - a.planned),
    unassignedResources: table(s.xer, "RSRC")
      .filter((r) => !totals.has(r.rsrc_short_name))
      .map((r) => r.rsrc_short_name),
  };
}

// ---------------------------------------------------------------- DCMA 14

export interface Check {
  id: number;
  name: string;
  metric: string;
  threshold: string;
  value: number | string | null;
  pass: boolean | null;
  count?: number;
  of?: number;
  examples?: string[];
  note?: string;
}

const ids = (acts: Activity[], max = 25) => acts.slice(0, max).map((a) => `${a.id} ${a.name}`);
const relIds = (rels: Relationship[], max = 25) => rels.slice(0, max).map((r) => `${r.pred.id} -> ${r.succ.id} ${r.type} lag ${r.lagDays}d`);

/**
 * DCMA 14-point assessment. Planned (target) dates stand in for the baseline
 * unless a baseline schedule is given, in which case activities are matched
 * by activity ID.
 */
export function dcmaCheck(s: Schedule, baseline?: Schedule) {
  const dd = s.dataDateMs;
  const incomplete = s.activities.filter((a) => !isComplete(a) && !isSummaryType(a));
  const tasks = incomplete.filter((a) => !isMilestone(a));
  const rels = s.relationships.filter((r) => !isComplete(r.succ) && !isSummaryType(r.succ) && !isSummaryType(r.pred));
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const ratio = (id: number, name: string, items: Activity[], of: number, limit: number, note?: string, cmp: "max" | "min" = "max") => {
    const value = pct(items.length, of);
    add({
      id,
      name,
      metric: `% of ${of} activities`,
      threshold: cmp === "max" ? (limit === 0 ? "0%" : `<= ${limit}%`) : `>= ${limit}%`,
      value,
      pass: of === 0 ? null : cmp === "max" ? value <= limit : value >= limit,
      count: items.length,
      of,
      examples: ids(items),
      note,
    });
  };

  // 1 Logic
  const noPred = incomplete.filter((a) => a.preds.length === 0);
  const noSucc = incomplete.filter((a) => a.succs.length === 0);
  const openEnds = [...new Set([...noPred, ...noSucc])];
  ratio(1, "Logic (missing predecessors or successors)", openEnds, incomplete.length, 5,
    `${noPred.length} without predecessors, ${noSucc.length} without successors. The project start and finish milestones are expected to show up here.`);

  // 2 Leads, 3 Lags, 4 Relationship types
  const leads = rels.filter((r) => r.lagDays < 0);
  const lags = rels.filter((r) => r.lagDays > 0);
  const fs = rels.filter((r) => r.type === "FS");
  const relCheck = (id: number, name: string, items: Relationship[], limit: number, cmp: "max" | "min", note?: string) => {
    const value = pct(items.length, rels.length);
    add({
      id,
      name,
      metric: `% of ${rels.length} relationships`,
      threshold: cmp === "max" ? (limit === 0 ? "0%" : `<= ${limit}%`) : `>= ${limit}%`,
      value,
      pass: rels.length === 0 ? null : cmp === "max" ? value <= limit : value >= limit,
      count: items.length,
      of: rels.length,
      examples: cmp === "max" ? relIds(items) : relIds(rels.filter((r) => r.type !== "FS")),
      note,
    });
  };
  relCheck(2, "Leads (negative lag)", leads, 0, "max");
  relCheck(3, "Lags (positive lag)", lags, 5, "max");
  relCheck(4, "Relationship types (finish-to-start)", fs, 90, "min", "Examples list the non-FS relationships.");

  // 5 Hard constraints
  const hard = incomplete.filter((a) => HARD_CONSTRAINTS.has(a.constraintCode ?? "") || HARD_CONSTRAINTS.has(a.secondaryConstraintCode ?? ""));
  ratio(5, "Hard constraints", hard, incomplete.length, 5, "Start On, Finish On, Start/Finish On or Before, Mandatory Start and Mandatory Finish.");

  // 6 High float, 7 Negative float
  ratio(6, "High float (total float > 44 days)", incomplete.filter((a) => (a.totalFloatDays ?? 0) > 44), incomplete.length, 5);
  ratio(7, "Negative float", incomplete.filter((a) => (a.totalFloatDays ?? 0) < 0), incomplete.length, 0);

  // 8 High duration
  ratio(8, "High duration (original duration > 44 days)", tasks.filter((a) => a.originalDurationDays > 44), tasks.length, 5, "Milestones excluded.");

  // 9 Invalid dates
  if (dd === undefined) {
    add({ id: 9, name: "Invalid dates", metric: "count", threshold: "0", value: null, pass: null, note: "The project has no data date." });
  } else {
    const invalid = s.activities.filter((a) => {
      const as = parseDate(a.actualStart);
      const af = parseDate(a.actualFinish);
      if ((as !== undefined && as > dd) || (af !== undefined && af > dd)) return true;
      if (isComplete(a)) return false;
      if (!a.actualStart && (parseDate(a.earlyStart) ?? Infinity) < dd) return true;
      return (parseDate(a.earlyFinish) ?? Infinity) < dd;
    });
    add({ id: 9, name: "Invalid dates", metric: "count", threshold: "0", value: invalid.length, pass: invalid.length === 0, count: invalid.length, of: s.activities.length, examples: ids(invalid),
      note: "Actual dates after the data date, or forecast dates before it." });
  }

  // 10 Resources
  if (!s.hasResources) {
    add({ id: 10, name: "Resources", metric: "% of activities", threshold: "0%", value: null, pass: null, note: "The schedule has no resource assignments, so this check doesn't apply." });
  } else {
    ratio(10, "Resources (activities with duration but no resources)", tasks.filter((a) => a.originalDurationDays > 0 && a.assignments.length === 0), tasks.length, 0);
  }

  // 11 Missed tasks, 14 BEI
  const baseFinish = (a: Activity): number | undefined => {
    if (!baseline) return parseDate(a.plannedFinish);
    const b = baseline.byId.get(a.id);
    return b?.finishMs;
  };
  const baseSource = baseline ? `baseline ${baseline.xer.path}` : "planned (target) dates, because no baseline was given";
  if (dd === undefined) {
    add({ id: 11, name: "Missed tasks", metric: "%", threshold: "<= 5%", value: null, pass: null, note: "The project has no data date." });
    add({ id: 14, name: "Baseline Execution Index (BEI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "The project has no data date." });
  } else {
    const work = s.activities.filter((a) => !isSummaryType(a));
    const dueByNow = work.filter((a) => (baseFinish(a) ?? Infinity) <= dd);
    const missed = dueByNow.filter((a) => !isComplete(a) || (parseDate(a.actualFinish) ?? Infinity) > baseFinish(a)!);
    ratio(11, "Missed tasks", missed, dueByNow.length, 5, `Compared with ${baseSource}.`);
    const completed = work.filter(isComplete).length;
    const bei = dueByNow.length === 0 ? null : round(completed / dueByNow.length, 2);
    add({ id: 14, name: "Baseline Execution Index (BEI)", metric: "completed / due by data date", threshold: ">= 0.95", value: bei, pass: bei === null ? null : bei >= 0.95,
      count: completed, of: dueByNow.length, note: `Compared with ${baseSource}.` });
  }

  // 12 Critical path test, 13 CPLI
  const finishAct = latestFinish(incomplete);
  if (!finishAct) {
    add({ id: 12, name: "Critical path test", metric: "pass/fail", threshold: "continuous path", value: null, pass: null, note: "No incomplete activities." });
    add({ id: 13, name: "Critical Path Length Index (CPLI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "No incomplete activities." });
  } else {
    const trace = drivingPath(s, finishAct);
    const first = trace.path[0];
    const firstAct = s.byId.get(first.id)!;
    const reachesStart = Boolean(firstAct.actualStart) || firstAct.preds.length === 0 && (dd === undefined || (firstAct.startMs ?? Infinity) - dd <= DAY);
    const breaks = trace.path.filter((p) => p.drives && Math.abs(p.drives.gapDays ?? 0) > 1);
    add({
      id: 12,
      name: "Critical path test",
      metric: "driving path from the data date to the project finish",
      threshold: "continuous path",
      value: `${trace.steps} activities, ${breaks.length} gaps over 1 day`,
      pass: reachesStart && breaks.length === 0,
      examples: trace.path.map((p) => `${p.id} ${p.name}${p.drives ? ` -(${p.drives.type}, gap ${p.drives.gapDays}d)->` : ""}`).slice(0, 40),
      note: "Approximation from exported dates: DCMA's version of this test delays a critical activity and checks that the finish moves by the same amount, which needs P6 to reschedule. Use p6_schedule_project for that.",
    });
    if (dd === undefined || finishAct.finishMs === undefined) {
      add({ id: 13, name: "Critical Path Length Index (CPLI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "The project has no data date." });
    } else {
      const cpl = workPos(finishAct.finishMs, finishAct.workDaysPerWeek) - workPos(dd, finishAct.workDaysPerWeek);
      const tf = finishAct.totalFloatDays ?? 0;
      const cpli = cpl <= 0 ? null : round((cpl + tf) / cpl, 2);
      add({ id: 13, name: "Critical Path Length Index (CPLI)", metric: "(CPL + TF) / CPL", threshold: ">= 0.95", value: cpli, pass: cpli === null ? null : cpli >= 0.95,
        note: `Critical path length ${round(cpl, 1)} working days from the data date to ${finishAct.id} (${finishAct.finish}), total float ${tf} days.` });
    }
  }

  checks.sort((a, b) => a.id - b.id);
  const scored = checks.filter((c) => c.pass !== null);
  return {
    project: s.projectCode,
    dataDate: s.dataDate,
    passed: scored.filter((c) => c.pass).length,
    failed: scored.filter((c) => !c.pass).length,
    notApplicable: checks.length - scored.length,
    incompleteActivities: incomplete.length,
    checks,
  };
}

// ---------------------------------------------------------------- compare

const daysBetween = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : round((b - a) / DAY, 1));
const relKey = (r: Relationship) => `${r.pred.id}|${r.succ.id}|${r.type}`;

export function compareSchedules(prev: Schedule, curr: Schedule, limit = 100) {
  const added = curr.activities.filter((a) => !prev.byId.has(a.id));
  const removed = prev.activities.filter((a) => !curr.byId.has(a.id));
  const changed: Record<string, unknown>[] = [];
  for (const a of curr.activities) {
    const b = prev.byId.get(a.id);
    if (!b) continue;
    const diff: Record<string, unknown> = {};
    if (a.name !== b.name) diff.name = { from: b.name, to: a.name };
    if (a.status !== b.status) diff.status = { from: b.status, to: a.status };
    if (a.originalDurationDays !== b.originalDurationDays) diff.originalDuration = { from: b.originalDurationDays, to: a.originalDurationDays };
    if (a.constraintCode !== b.constraintCode || a.constraintDate !== b.constraintDate)
      diff.constraint = { from: b.constraint ? `${b.constraint} ${b.constraintDate ?? ""}`.trim() : null, to: a.constraint ? `${a.constraint} ${a.constraintDate ?? ""}`.trim() : null };
    const startSlip = daysBetween(b.startMs, a.startMs);
    const finishSlip = daysBetween(b.finishMs, a.finishMs);
    if (startSlip) diff.startSlipDays = startSlip;
    if (finishSlip) diff.finishSlipDays = finishSlip;
    if (a.totalFloatDays !== b.totalFloatDays) diff.totalFloat = { from: b.totalFloatDays, to: a.totalFloatDays };
    if (Object.keys(diff).length) changed.push({ id: a.id, name: a.name, finish: a.finish, ...diff });
  }
  changed.sort((x, y) => Math.abs(Number(y.finishSlipDays ?? 0)) - Math.abs(Number(x.finishSlipDays ?? 0)));

  const prevRels = new Map(prev.relationships.map((r) => [relKey(r), r]));
  const currRels = new Map(curr.relationships.map((r) => [relKey(r), r]));
  const relDesc = (r: Relationship) => `${r.pred.id} -> ${r.succ.id} ${r.type}${r.lagDays ? ` lag ${r.lagDays}d` : ""}`;
  const logicAdded = [...currRels.entries()].filter(([k]) => !prevRels.has(k)).map(([, r]) => relDesc(r));
  const logicRemoved = [...prevRels.entries()].filter(([k]) => !currRels.has(k)).map(([, r]) => relDesc(r));
  const lagChanged = [...currRels.entries()]
    .filter(([k, r]) => prevRels.has(k) && prevRels.get(k)!.lagDays !== r.lagDays)
    .map(([k, r]) => `${relDesc(r)} (was ${prevRels.get(k)!.lagDays}d)`);

  const pf = latestFinish(prev.activities);
  const cf = latestFinish(curr.activities);
  const progressed = curr.activities.filter((a) => {
    const b = prev.byId.get(a.id);
    return b && a.percentComplete > b.percentComplete;
  });
  const cut = <T>(xs: T[]) => xs.slice(0, limit);
  return {
    previous: { file: prev.xer.path, project: prev.projectCode, dataDate: prev.dataDate, finish: pf?.finish, activities: prev.activities.length },
    current: { file: curr.xer.path, project: curr.projectCode, dataDate: curr.dataDate, finish: cf?.finish, activities: curr.activities.length },
    note: "Slips and moves are calendar days; positive means later.",
    projectFinishSlipDays: daysBetween(pf?.finishMs, cf?.finishMs),
    dataDateMovedDays: daysBetween(prev.dataDateMs, curr.dataDateMs),
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      progressed: progressed.length,
      newlyCompleted: curr.activities.filter((a) => isComplete(a) && prev.byId.get(a.id) && !isComplete(prev.byId.get(a.id)!)).length,
      newlyStarted: curr.activities.filter((a) => a.actualStart && prev.byId.get(a.id) && !prev.byId.get(a.id)!.actualStart).length,
      logicAdded: logicAdded.length,
      logicRemoved: logicRemoved.length,
      lagChanged: lagChanged.length,
    },
    added: cut(added.map(brief)),
    removed: cut(removed.map(brief)),
    changed: cut(changed),
    logicAdded: cut(logicAdded),
    logicRemoved: cut(logicRemoved),
    lagChanged: cut(lagChanged),
    truncatedTo: limit,
  };
}
