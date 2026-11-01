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

const pct = (value: number, day: number) => (day === 0 ? 0 : round((value / day) * 100, 1));
const byStart = (activity: Activity, other: Activity) =>
  (activity.startMs ?? Infinity) - (other.startMs ?? Infinity) || (activity.finishMs ?? Infinity) - (other.finishMs ?? Infinity) || activity.id.localeCompare(other.id);

/** Activity that finishes last; on a tie, prefer a finish milestone, then one without successors. */
export function latestFinish(acts: Activity[]): Activity | undefined {
  const rank = (activity: Activity) => (activity.type === "Finish Milestone" ? 2 : 0) + (activity.succs.length === 0 ? 1 : 0);
  let best: Activity | undefined;
  for (const activity of acts) {
    if (activity.finishMs === undefined) continue;
    if (!best || activity.finishMs > best.finishMs! || (activity.finishMs === best.finishMs && rank(activity) > rank(best))) best = activity;
  }
  return best;
}

function earliestStart(acts: Activity[]): Activity | undefined {
  let best: Activity | undefined;
  for (const activity of acts) if (activity.startMs !== undefined && (!best || activity.startMs < best.startMs!)) best = activity;
  return best;
}

export function summary(schedule: Schedule, criticalFloatDays = 0) {
  const acts = schedule.activities;
  const count = (field: (activity: Activity) => boolean) => acts.filter(field).length;
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const activity of acts) {
    byStatus[activity.status] = (byStatus[activity.status] ?? 0) + 1;
    byType[activity.type] = (byType[activity.type] ?? 0) + 1;
  }
  const work = acts.filter((activity) => !isSummaryType(activity));
  const totalOrig = work.reduce((value, activity) => value + activity.originalDurationDays, 0);
  const earned = work.reduce((value, activity) => value + activity.originalDurationDays * (activity.percentComplete / 100), 0);
  const finishAct = latestFinish(acts);
  const startAct = earliestStart(acts);
  const cost = acts.flatMap((activity) => activity.assignments).reduce(
    (item, assignment) => ({ planned: item.planned + assignment.plannedCost, actual: item.actual + assignment.actualCost, remaining: item.remaining + assignment.remainingCost }),
    { planned: 0, actual: 0, remaining: 0 },
  );
  return {
    file: schedule.xer.path,
    p6Version: schedule.xer.version,
    exportDate: schedule.xer.exportDate,
    project: { code: schedule.projectCode, name: schedule.projectName },
    dataDate: schedule.dataDate,
    plannedStart: schedule.plannedStart,
    mustFinishBy: schedule.mustFinishBy,
    scheduledFinish: schedule.scheduledFinish,
    start: startAct?.start,
    finish: finishAct?.finish,
    finishActivity: finishAct ? { id: finishAct.id, name: finishAct.name } : undefined,
    activities: acts.length,
    relationships: schedule.relationships.length,
    wbsElements: [...schedule.wbs.values()].filter((node) => !node.isProjectNode).length,
    byStatus,
    byType,
    durationWeightedPercentComplete: pct(earned, totalOrig),
    critical: count((activity) => !isComplete(activity) && (activity.totalFloatDays ?? Infinity) <= criticalFloatDays),
    negativeFloat: count((activity) => !isComplete(activity) && (activity.totalFloatDays ?? 0) < 0),
    longestPath: count((activity) => activity.longestPath),
    resourceAssignments: acts.reduce((value, activity) => value + activity.assignments.length, 0),
    cost: schedule.hasResources ? { planned: round(cost.planned), actual: round(cost.actual), remaining: round(cost.remaining) } : undefined,
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

export function filterActivities(schedule: Schedule, field: ActivityFilter): Activity[] {
  const startsAfter = parseDate(field.startsAfter);
  const finishesBefore = parseDate(field.finishesBefore);
  const search = field.search?.toLowerCase();
  const wbs = field.wbs?.toLowerCase();
  const resource = field.resource?.toLowerCase();
  const types = field.types?.map((item) => item.toLowerCase());
  return schedule.activities
    .filter((activity) => {
      if (field.status?.length && !field.status.includes(activity.status as never)) return false;
      if (types?.length && !types.some((item) => activity.type.toLowerCase().includes(item))) return false;
      if (wbs && !activity.wbsCode.toLowerCase().startsWith(wbs) && !activity.wbsPath.toLowerCase().includes(wbs)) return false;
      if (search && !activity.id.toLowerCase().includes(search) && !activity.name.toLowerCase().includes(search)) return false;
      if (field.maxFloat !== undefined && !((activity.totalFloatDays ?? Infinity) <= field.maxFloat)) return false;
      if (field.minFloat !== undefined && !((activity.totalFloatDays ?? -Infinity) >= field.minFloat)) return false;
      if (field.longestPathOnly && !activity.longestPath) return false;
      if (startsAfter !== undefined && !((activity.startMs ?? -Infinity) >= startsAfter)) return false;
      if (finishesBefore !== undefined && !((activity.finishMs ?? Infinity) <= finishesBefore)) return false;
      if (field.hasConstraint !== undefined && Boolean(activity.constraintCode) !== field.hasConstraint) return false;
      if (resource && !activity.assignments.some((assignment) => assignment.resourceId.toLowerCase().includes(resource) || assignment.resourceName.toLowerCase().includes(resource)))
        return false;
      return true;
    })
    .sort(byStart);
}

export function criticalPath(schedule: Schedule, floatThreshold = 0, includeCompleted = false) {
  const acts = schedule.activities
    .filter((activity) => (includeCompleted || !isComplete(activity)) && !isSummaryType(activity))
    .filter((activity) => (activity.totalFloatDays ?? Infinity) <= floatThreshold || (floatThreshold <= 0 && activity.longestPath && !isComplete(activity)))
    .sort(byStart);
  return {
    project: schedule.projectCode,
    dataDate: schedule.dataDate,
    floatThreshold,
    count: acts.length,
    note: "Activities whose total float is at or below the threshold, plus those P6 flagged as on the longest path, ordered by start.",
    activities: acts.map((activity) => ({ ...brief(activity), onLongestPath: activity.longestPath })),
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
function relGap(rel: Relationship): number | undefined {
  const { pred, succ } = rel;
  const base = rel.type === "SS" || rel.type === "SF" ? pred.startMs : pred.finishMs;
  const target = rel.type === "FF" || rel.type === "SF" ? succ.finishMs : succ.startMs;
  if (base === undefined || target === undefined) return undefined;
  const wd = succ.workDaysPerWeek;
  return workPos(target, wd) - workPos(base, wd) - rel.lagDays;
}

export function drivingPath(schedule: Schedule, target: Activity, maxSteps = 500) {
  const path: { activity: Activity; via?: Relationship; gap?: number }[] = [{ activity: target }];
  const seen = new Set([target.taskId]);
  let current = target;
  for (let index = 0; index < maxSteps; index++) {
    if (isComplete(current) || current.actualStart) break; // driven by the data date from here
    let best: { r: Relationship; gap: number } | undefined;
    for (const rel of current.preds) {
      if (seen.has(rel.pred.taskId)) continue;
      const gap = relGap(rel);
      if (gap === undefined) continue;
      if (!best || gap < best.gap) best = { r: rel, gap };
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
      .map(({ activity: activity, via, gap }) => ({ ...brief(activity), drives: via ? { successor: via.succ.id, type: via.type, lag: via.lagDays, gapDays: gap } : undefined })),
  };
}

export function lookahead(schedule: Schedule, days: number, from?: string) {
  const fromMs = parseDate(from) ?? schedule.dataDateMs ?? Date.now();
  const toMs = fromMs + days * DAY;
  const acts = schedule.activities
    .filter((activity) => !isComplete(activity) && !isSummaryType(activity))
    .filter((activity) => (activity.startMs ?? Infinity) < toMs && (activity.finishMs ?? -Infinity) >= fromMs)
    .sort(byStart);
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    project: schedule.projectCode,
    window: { from: fmt(fromMs), to: fmt(toMs), days },
    starting: acts.filter((activity) => !activity.actualStart && (activity.startMs ?? Infinity) >= fromMs).length,
    inProgress: acts.filter((activity) => activity.actualStart).length,
    finishing: acts.filter((activity) => (activity.finishMs ?? Infinity) < toMs).length,
    activities: acts.map((activity) => ({ ...brief(activity), resources: activity.assignments.map((assignment) => assignment.resourceId) })),
  };
}

export function wbsTree(schedule: Schedule, maxDepth = 10) {
  const children = new Map<string, string[]>();
  for (const node of schedule.wbs.values()) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId)!.push(node.wbsId);
  }
  const actsByWbs = new Map<string, Activity[]>();
  for (const activity of schedule.activities) {
    if (!actsByWbs.has(activity.wbsId)) actsByWbs.set(activity.wbsId, []);
    actsByWbs.get(activity.wbsId)!.push(activity);
  }
  type Node = { code: string; name: string; activities: number; start?: string; finish?: string; minFloat?: number; children?: Node[] };
  const all = (id: string): Activity[] => [...(actsByWbs.get(id) ?? []), ...(children.get(id) ?? []).flatMap(all)];
  const build = (id: string, depth: number): Node => {
    const node = schedule.wbs.get(id)!;
    const acts = all(id);
    const floats = acts.filter((activity) => !isComplete(activity) && activity.totalFloatDays !== undefined).map((activity) => activity.totalFloatDays!);
    const kids = (children.get(id) ?? []).map((key) => schedule.wbs.get(key)!).sort((wbsNode, child) => wbsNode.seq - child.seq || wbsNode.code.localeCompare(child.code));
    return {
      code: node.isProjectNode ? schedule.projectCode : node.path,
      name: node.name,
      activities: acts.length,
      start: earliestStart(acts)?.start,
      finish: latestFinish(acts)?.finish,
      minFloat: floats.length ? Math.min(...floats) : undefined,
      children: depth < maxDepth && kids.length ? kids.map((wbsNode) => build(wbsNode.wbsId, depth + 1)) : undefined,
    };
  };
  const root = [...schedule.wbs.values()].find((node) => node.isProjectNode);
  if (root) return build(root.wbsId, 0);
  return { code: schedule.projectCode, name: schedule.projectName, children: [...schedule.wbs.values()].filter((node) => !schedule.wbs.has(node.parentId)).map((node) => build(node.wbsId, 1)) };
}

export function resourceSummary(schedule: Schedule) {
  const totals = new Map<string, { id: string; name: string; type: string; activities: number; planned: number; actual: number; remaining: number; plannedCost: number; actualCost: number; remainingCost: number }>();
  for (const activity of schedule.activities)
    for (const assignment of activity.assignments) {
      const item = totals.get(assignment.resourceId) ?? { id: assignment.resourceId, name: assignment.resourceName, type: assignment.resourceType, activities: 0, planned: 0, actual: 0, remaining: 0, plannedCost: 0, actualCost: 0, remainingCost: 0 };
      item.activities++;
      item.planned += assignment.plannedUnits;
      item.actual += assignment.actualUnits;
      item.remaining += assignment.remainingUnits;
      item.plannedCost += assignment.plannedCost;
      item.actualCost += assignment.actualCost;
      item.remainingCost += assignment.remainingCost;
      totals.set(assignment.resourceId, item);
    }
  const list = [...totals.values()].map((item) => ({
    ...item,
    planned: round(item.planned),
    actual: round(item.actual),
    remaining: round(item.remaining),
    plannedCost: round(item.plannedCost),
    actualCost: round(item.actualCost),
    remainingCost: round(item.remainingCost),
  }));
  return {
    project: schedule.projectCode,
    note: "Units are hours for labor and nonlabor resources and the resource's unit of measure for material.",
    resources: list.sort((first, second) => second.planned - first.planned),
    unassignedResources: table(schedule.xer, "RSRC")
      .filter((row) => !totals.has(row.rsrc_short_name))
      .map((row) => row.rsrc_short_name),
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

const ids = (acts: Activity[], max = 25) => acts.slice(0, max).map((activity) => `${activity.id} ${activity.name}`);
const relIds = (rels: Relationship[], max = 25) => rels.slice(0, max).map((rel) => `${rel.pred.id} -> ${rel.succ.id} ${rel.type} lag ${rel.lagDays}d`);

/**
 * DCMA 14-point assessment. Planned (target) dates stand in for the baseline
 * unless a baseline schedule is given, in which case activities are matched
 * by activity ID.
 */
export function dcmaCheck(schedule: Schedule, baseline?: Schedule) {
  const dd = schedule.dataDateMs;
  const incomplete = schedule.activities.filter((activity) => !isComplete(activity) && !isSummaryType(activity));
  const tasks = incomplete.filter((activity) => !isMilestone(activity));
  const rels = schedule.relationships.filter((rel) => !isComplete(rel.succ) && !isSummaryType(rel.succ) && !isSummaryType(rel.pred));
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
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
  const noPred = incomplete.filter((activity) => activity.preds.length === 0);
  const noSucc = incomplete.filter((activity) => activity.succs.length === 0);
  const openEnds = [...new Set([...noPred, ...noSucc])];
  ratio(1, "Logic (missing predecessors or successors)", openEnds, incomplete.length, 5,
    `${noPred.length} without predecessors, ${noSucc.length} without successors. The project start and finish milestones are expected to show up here.`);

  // 2 Leads, 3 Lags, 4 Relationship types
  const leads = rels.filter((rel) => rel.lagDays < 0);
  const lags = rels.filter((rel) => rel.lagDays > 0);
  const fs = rels.filter((rel) => rel.type === "FS");
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
      examples: cmp === "max" ? relIds(items) : relIds(rels.filter((rel) => rel.type !== "FS")),
      note,
    });
  };
  relCheck(2, "Leads (negative lag)", leads, 0, "max");
  relCheck(3, "Lags (positive lag)", lags, 5, "max");
  relCheck(4, "Relationship types (finish-to-start)", fs, 90, "min", "Examples list the non-FS relationships.");

  // 5 Hard constraints
  const hard = incomplete.filter((activity) => HARD_CONSTRAINTS.has(activity.constraintCode ?? "") || HARD_CONSTRAINTS.has(activity.secondaryConstraintCode ?? ""));
  ratio(5, "Hard constraints", hard, incomplete.length, 5, "Start On, Finish On, Start/Finish On or Before, Mandatory Start and Mandatory Finish.");

  // 6 High float, 7 Negative float
  ratio(6, "High float (total float > 44 days)", incomplete.filter((activity) => (activity.totalFloatDays ?? 0) > 44), incomplete.length, 5);
  ratio(7, "Negative float", incomplete.filter((activity) => (activity.totalFloatDays ?? 0) < 0), incomplete.length, 0);

  // 8 High duration
  ratio(8, "High duration (original duration > 44 days)", tasks.filter((activity) => activity.originalDurationDays > 44), tasks.length, 5, "Milestones excluded.");

  // 9 Invalid dates
  if (dd === undefined) {
    add({ id: 9, name: "Invalid dates", metric: "count", threshold: "0", value: null, pass: null, note: "The project has no data date." });
  } else {
    const invalid = schedule.activities.filter((activity) => {
      const as = parseDate(activity.actualStart);
      const af = parseDate(activity.actualFinish);
      if ((as !== undefined && as > dd) || (af !== undefined && af > dd)) return true;
      if (isComplete(activity)) return false;
      if (!activity.actualStart && (parseDate(activity.earlyStart) ?? Infinity) < dd) return true;
      return (parseDate(activity.earlyFinish) ?? Infinity) < dd;
    });
    add({ id: 9, name: "Invalid dates", metric: "count", threshold: "0", value: invalid.length, pass: invalid.length === 0, count: invalid.length, of: schedule.activities.length, examples: ids(invalid),
      note: "Actual dates after the data date, or forecast dates before it." });
  }

  // 10 Resources
  if (!schedule.hasResources) {
    add({ id: 10, name: "Resources", metric: "% of activities", threshold: "0%", value: null, pass: null, note: "The schedule has no resource assignments, so this check doesn't apply." });
  } else {
    ratio(10, "Resources (activities with duration but no resources)", tasks.filter((activity) => activity.originalDurationDays > 0 && activity.assignments.length === 0), tasks.length, 0);
  }

  // 11 Missed tasks, 14 BEI
  const baseFinish = (activity: Activity): number | undefined => {
    if (!baseline) return parseDate(activity.plannedFinish);
    const other = baseline.byId.get(activity.id);
    return other?.finishMs;
  };
  const baseSource = baseline ? `baseline ${baseline.xer.path}` : "planned (target) dates, because no baseline was given";
  if (dd === undefined) {
    add({ id: 11, name: "Missed tasks", metric: "%", threshold: "<= 5%", value: null, pass: null, note: "The project has no data date." });
    add({ id: 14, name: "Baseline Execution Index (BEI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "The project has no data date." });
  } else {
    const work = schedule.activities.filter((activity) => !isSummaryType(activity));
    const dueByNow = work.filter((activity) => (baseFinish(activity) ?? Infinity) <= dd);
    const missed = dueByNow.filter((activity) => !isComplete(activity) || (parseDate(activity.actualFinish) ?? Infinity) > baseFinish(activity)!);
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
    const trace = drivingPath(schedule, finishAct);
    const first = trace.path[0];
    const firstAct = schedule.byId.get(first.id)!;
    const reachesStart = Boolean(firstAct.actualStart) || firstAct.preds.length === 0 && (dd === undefined || (firstAct.startMs ?? Infinity) - dd <= DAY);
    const breaks = trace.path.filter((part) => part.drives && Math.abs(part.drives.gapDays ?? 0) > 1);
    add({
      id: 12,
      name: "Critical path test",
      metric: "driving path from the data date to the project finish",
      threshold: "continuous path",
      value: `${trace.steps} activities, ${breaks.length} gaps over 1 day`,
      pass: reachesStart && breaks.length === 0,
      examples: trace.path.map((part) => `${part.id} ${part.name}${part.drives ? ` -(${part.drives.type}, gap ${part.drives.gapDays}d)->` : ""}`).slice(0, 40),
      note: "Approximation from exported dates: DCMA's version of this test delays a critical activity and checks that the finish moves by the same amount, which needs P6 to reschedule. Rescheduling in P6 (or p6_schedule_project in the MCP server) gives the exact result.",
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

  checks.sort((check, second) => check.id - second.id);
  const scored = checks.filter((check) => check.pass !== null);
  return {
    project: schedule.projectCode,
    dataDate: schedule.dataDate,
    passed: scored.filter((check) => check.pass).length,
    failed: scored.filter((check) => !check.pass).length,
    notApplicable: checks.length - scored.length,
    incompleteActivities: incomplete.length,
    checks,
  };
}

// ---------------------------------------------------------------- compare

const daysBetween = (first?: number, second?: number) => (first === undefined || second === undefined ? undefined : round((second - first) / DAY, 1));
const relKey = (rel: Relationship) => `${rel.pred.id}|${rel.succ.id}|${rel.type}`;

export function compareSchedules(prev: Schedule, curr: Schedule, limit = 100) {
  const added = curr.activities.filter((activity) => !prev.byId.has(activity.id));
  const removed = prev.activities.filter((activity) => !curr.byId.has(activity.id));
  const changed: Record<string, unknown>[] = [];
  for (const activity of curr.activities) {
    const other = prev.byId.get(activity.id);
    if (!other) continue;
    const diff: Record<string, unknown> = {};
    if (activity.name !== other.name) diff.name = { from: other.name, to: activity.name };
    if (activity.status !== other.status) diff.status = { from: other.status, to: activity.status };
    if (activity.originalDurationDays !== other.originalDurationDays) diff.originalDuration = { from: other.originalDurationDays, to: activity.originalDurationDays };
    if (activity.constraintCode !== other.constraintCode || activity.constraintDate !== other.constraintDate)
      diff.constraint = { from: other.constraint ? `${other.constraint} ${other.constraintDate ?? ""}`.trim() : null, to: activity.constraint ? `${activity.constraint} ${activity.constraintDate ?? ""}`.trim() : null };
    const startSlip = daysBetween(other.startMs, activity.startMs);
    const finishSlip = daysBetween(other.finishMs, activity.finishMs);
    if (startSlip) diff.startSlipDays = startSlip;
    if (finishSlip) diff.finishSlipDays = finishSlip;
    if (activity.totalFloatDays !== other.totalFloatDays) diff.totalFloat = { from: other.totalFloatDays, to: activity.totalFloatDays };
    if (Object.keys(diff).length) changed.push({ id: activity.id, name: activity.name, finish: activity.finish, ...diff });
  }
  changed.sort((item, other) => Math.abs(Number(other.finishSlipDays ?? 0)) - Math.abs(Number(item.finishSlipDays ?? 0)));

  const prevRels = new Map(prev.relationships.map((rel) => [relKey(rel), rel]));
  const currRels = new Map(curr.relationships.map((rel) => [relKey(rel), rel]));
  const relDesc = (rel: Relationship) => `${rel.pred.id} -> ${rel.succ.id} ${rel.type}${rel.lagDays ? ` lag ${rel.lagDays}d` : ""}`;
  const logicAdded = [...currRels.entries()].filter(([key]) => !prevRels.has(key)).map(([, rel]) => relDesc(rel));
  const logicRemoved = [...prevRels.entries()].filter(([key]) => !currRels.has(key)).map(([, rel]) => relDesc(rel));
  const lagChanged = [...currRels.entries()]
    .filter(([key, rel]) => prevRels.has(key) && prevRels.get(key)!.lagDays !== rel.lagDays)
    .map(([key, rel]) => `${relDesc(rel)} (was ${prevRels.get(key)!.lagDays}d)`);

  const pf = latestFinish(prev.activities);
  const cf = latestFinish(curr.activities);
  const progressed = curr.activities.filter((activity) => {
    const other = prev.byId.get(activity.id);
    return other && activity.percentComplete > other.percentComplete;
  });
  const cut = <Item>(xs: Item[]) => xs.slice(0, limit);
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
      newlyCompleted: curr.activities.filter((activity) => isComplete(activity) && prev.byId.get(activity.id) && !isComplete(prev.byId.get(activity.id)!)).length,
      newlyStarted: curr.activities.filter((activity) => activity.actualStart && prev.byId.get(activity.id) && !prev.byId.get(activity.id)!.actualStart).length,
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
