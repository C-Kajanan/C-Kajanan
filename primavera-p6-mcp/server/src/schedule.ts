// Turns the raw XER tables of one project into a linked schedule model
// (activities, relationships, WBS, resources) that the analysis tools use.

import { num, parseDate, table, XerError, type Row, type XerFile } from "./xer.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const TASK_TYPES: Record<string, string> = {
  TT_Task: "Task Dependent",
  TT_Rsrc: "Resource Dependent",
  TT_LOE: "Level of Effort",
  TT_Mile: "Start Milestone",
  TT_FinMile: "Finish Milestone",
  TT_WBS: "WBS Summary",
};

export const STATUSES: Record<string, string> = {
  TK_NotStart: "Not Started",
  TK_Active: "In Progress",
  TK_Complete: "Completed",
};

export const CONSTRAINTS: Record<string, string> = {
  CS_ALAP: "As Late As Possible",
  CS_MSO: "Start On",
  CS_MSOA: "Start On or After",
  CS_MSOB: "Start On or Before",
  CS_MEO: "Finish On",
  CS_MEOA: "Finish On or After",
  CS_MEOB: "Finish On or Before",
  CS_MANDSTART: "Mandatory Start",
  CS_MANDFIN: "Mandatory Finish",
};

/** Constraints that stop the schedule from moving freely (DCMA check 5). */
export const HARD_CONSTRAINTS = new Set(["CS_MSO", "CS_MEO", "CS_MSOB", "CS_MEOB", "CS_MANDSTART", "CS_MANDFIN"]);

export const REL_TYPES: Record<string, string> = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };

export interface Relationship {
  pred: Activity;
  succ: Activity;
  type: string; // FS, SS, FF, SF
  lagDays: number;
}

export interface Assignment {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  plannedUnits: number;
  actualUnits: number;
  remainingUnits: number;
  plannedCost: number;
  actualCost: number;
  remainingCost: number;
}

export interface Activity {
  taskId: string;
  id: string;
  name: string;
  type: string;
  status: string;
  wbsId: string;
  wbsCode: string;
  wbsPath: string;
  calendar: string;
  hoursPerDay: number;
  /** 5 for a Monday-Friday calendar, 7 for a seven-day calendar. */
  workDaysPerWeek: number;
  originalDurationDays: number;
  remainingDurationDays: number;
  totalFloatDays?: number;
  freeFloatDays?: number;
  percentComplete: number;
  start?: string;
  finish?: string;
  startMs?: number;
  finishMs?: number;
  actualStart?: string;
  actualFinish?: string;
  earlyStart?: string;
  earlyFinish?: string;
  lateStart?: string;
  lateFinish?: string;
  plannedStart?: string;
  plannedFinish?: string;
  constraint?: string;
  constraintCode?: string;
  constraintDate?: string;
  secondaryConstraint?: string;
  secondaryConstraintCode?: string;
  secondaryConstraintDate?: string;
  longestPath: boolean;
  preds: Relationship[];
  succs: Relationship[];
  assignments: Assignment[];
  row: Row;
}

export interface WbsNode {
  wbsId: string;
  parentId: string;
  code: string;
  name: string;
  path: string;
  seq: number;
  isProjectNode: boolean;
}

export interface Schedule {
  xer: XerFile;
  projectId: string;
  projectCode: string;
  projectName: string;
  dataDate?: string;
  dataDateMs?: number;
  plannedStart?: string;
  mustFinishBy?: string;
  scheduledFinish?: string;
  activities: Activity[];
  byId: Map<string, Activity>;
  byTaskId: Map<string, Activity>;
  relationships: Relationship[];
  wbs: Map<string, WbsNode>;
  hasResources: boolean;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const hrs = (row: Row, field: string) => num(row[field]);

export function listProjects(xer: XerFile) {
  const wbs = table(xer, "PROJWBS");
  return table(xer, "PROJECT").map((p) => ({
    projectId: p.proj_id,
    code: p.proj_short_name,
    name: wbs.find((w) => w.proj_id === p.proj_id && w.proj_node_flag === "Y")?.wbs_name ?? p.proj_short_name,
    exported: p.export_flag !== "N",
    dataDate: p.last_recalc_date || undefined,
    activityCount: table(xer, "TASK").filter((t) => t.proj_id === p.proj_id).length,
  }));
}

function pickProject(xer: XerFile, project?: string): Row {
  const projects = table(xer, "PROJECT");
  if (projects.length === 0) throw new XerError(`${xer.path} has no PROJECT table.`);
  if (project) {
    const p = projects.find(
      (r) => r.proj_short_name === project || r.proj_id === project || r.proj_short_name.toLowerCase() === project.toLowerCase(),
    );
    if (!p) throw new XerError(`Project "${project}" is not in ${xer.path}. Available: ${projects.map((r) => r.proj_short_name).join(", ")}`);
    return p;
  }
  const exported = projects.filter((r) => r.export_flag !== "N");
  if (exported.length === 1) return exported[0];
  if (projects.length === 1) return projects[0];
  throw new XerError(
    `${xer.path} contains ${projects.length} projects; pass "project" with one of: ${projects.map((r) => r.proj_short_name).join(", ")}`,
  );
}

const scheduleCache = new WeakMap<XerFile, Map<string, Schedule>>();

export function buildSchedule(xer: XerFile, project?: string): Schedule {
  const p = pickProject(xer, project);
  let perFile = scheduleCache.get(xer);
  if (!perFile) scheduleCache.set(xer, (perFile = new Map()));
  const cached = perFile.get(p.proj_id);
  if (cached) return cached;

  const calendars = new Map(table(xer, "CALENDAR").map((c) => [c.clndr_id, c]));
  const projCalendar = calendars.get(p.clndr_id);
  const defaultHpd = num(projCalendar?.day_hr_cnt) || 8;

  // WBS with full code paths.
  const wbsRows = table(xer, "PROJWBS").filter((w) => w.proj_id === p.proj_id);
  const wbs = new Map<string, WbsNode>();
  for (const w of wbsRows) {
    wbs.set(w.wbs_id, {
      wbsId: w.wbs_id,
      parentId: w.parent_wbs_id,
      code: w.wbs_short_name,
      name: w.wbs_name,
      path: "",
      seq: num(w.seq_num) ?? 0,
      isProjectNode: w.proj_node_flag === "Y",
    });
  }
  const pathOf = (id: string, depth = 0): string => {
    const node = wbs.get(id);
    if (!node || node.isProjectNode || depth > 50) return "";
    if (node.path) return node.path;
    const parent = pathOf(node.parentId, depth + 1);
    node.path = parent ? `${parent}.${node.code}` : node.code;
    return node.path;
  };
  for (const id of wbs.keys()) pathOf(id);
  const projectNode = [...wbs.values()].find((w) => w.isProjectNode);

  const activities: Activity[] = [];
  for (const t of table(xer, "TASK")) {
    if (t.proj_id !== p.proj_id) continue;
    const cal = calendars.get(t.clndr_id);
    const hpd = num(cal?.day_hr_cnt) || defaultHpd;
    const hpw = num(cal?.week_hr_cnt) || hpd * 5;
    const days = (field: string) => {
      const h = hrs(t, field);
      return h === undefined ? undefined : round(h / hpd);
    };
    const orig = days("target_drtn_hr_cnt") ?? 0;
    const remain = days("remain_drtn_hr_cnt") ?? 0;
    let pct = (num(t.phys_complete_pct) ?? 0) / 100;
    if (t.complete_pct_type === "CP_Drtn") pct = orig > 0 ? Math.max(0, Math.min(1, (orig - remain) / orig)) : t.status_code === "TK_Complete" ? 1 : 0;
    if (t.status_code === "TK_Complete") pct = 1;

    const start = t.act_start_date || t.restart_date || t.early_start_date || t.target_start_date || undefined;
    const finish = t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date || undefined;
    const node = wbs.get(t.wbs_id);
    activities.push({
      taskId: t.task_id,
      id: t.task_code,
      name: t.task_name,
      type: TASK_TYPES[t.task_type] ?? t.task_type,
      status: STATUSES[t.status_code] ?? t.status_code,
      wbsId: t.wbs_id,
      wbsCode: node?.path ?? "",
      wbsPath: wbsNamePath(wbs, t.wbs_id),
      calendar: cal?.clndr_name ?? "",
      hoursPerDay: hpd,
      workDaysPerWeek: hpw / hpd >= 6.5 ? 7 : 5,
      originalDurationDays: orig,
      remainingDurationDays: remain,
      totalFloatDays: days("total_float_hr_cnt"),
      freeFloatDays: days("free_float_hr_cnt"),
      percentComplete: round(pct * 100, 1),
      start,
      finish,
      startMs: parseDate(start),
      finishMs: parseDate(finish),
      actualStart: t.act_start_date || undefined,
      actualFinish: t.act_end_date || undefined,
      earlyStart: t.early_start_date || undefined,
      earlyFinish: t.early_end_date || undefined,
      lateStart: t.late_start_date || undefined,
      lateFinish: t.late_end_date || undefined,
      plannedStart: t.target_start_date || undefined,
      plannedFinish: t.target_end_date || undefined,
      constraintCode: t.cstr_type || undefined,
      constraint: t.cstr_type ? (CONSTRAINTS[t.cstr_type] ?? t.cstr_type) : undefined,
      constraintDate: t.cstr_date || undefined,
      secondaryConstraintCode: t.cstr_type2 || undefined,
      secondaryConstraint: t.cstr_type2 ? (CONSTRAINTS[t.cstr_type2] ?? t.cstr_type2) : undefined,
      secondaryConstraintDate: t.cstr_date2 || undefined,
      longestPath: t.driving_path_flag === "Y",
      preds: [],
      succs: [],
      assignments: [],
      row: t,
    });
  }
  const byTaskId = new Map(activities.map((a) => [a.taskId, a]));
  const byId = new Map(activities.map((a) => [a.id, a]));

  const relationships: Relationship[] = [];
  for (const r of table(xer, "TASKPRED")) {
    const succ = byTaskId.get(r.task_id);
    const pred = byTaskId.get(r.pred_task_id);
    if (!succ || !pred) continue; // relationship to another project
    const rel: Relationship = {
      pred,
      succ,
      type: REL_TYPES[r.pred_type] ?? r.pred_type,
      lagDays: round((num(r.lag_hr_cnt) ?? 0) / succ.hoursPerDay),
    };
    relationships.push(rel);
    pred.succs.push(rel);
    succ.preds.push(rel);
  }

  const resources = new Map(table(xer, "RSRC").map((r) => [r.rsrc_id, r]));
  const rsrcTypes: Record<string, string> = { RT_Labor: "Labor", RT_Equip: "Nonlabor", RT_Mat: "Material" };
  let hasResources = false;
  for (const tr of table(xer, "TASKRSRC")) {
    const a = byTaskId.get(tr.task_id);
    if (!a) continue;
    hasResources = true;
    const r = resources.get(tr.rsrc_id);
    a.assignments.push({
      resourceId: r?.rsrc_short_name ?? tr.rsrc_id,
      resourceName: r?.rsrc_name ?? "",
      resourceType: rsrcTypes[r?.rsrc_type ?? ""] ?? r?.rsrc_type ?? "",
      plannedUnits: num(tr.target_qty) ?? 0,
      actualUnits: (num(tr.act_reg_qty) ?? 0) + (num(tr.act_ot_qty) ?? 0),
      remainingUnits: num(tr.remain_qty) ?? 0,
      plannedCost: num(tr.target_cost) ?? 0,
      actualCost: (num(tr.act_reg_cost) ?? 0) + (num(tr.act_ot_cost) ?? 0),
      remainingCost: num(tr.remain_cost) ?? 0,
    });
  }

  const schedule: Schedule = {
    xer,
    projectId: p.proj_id,
    projectCode: p.proj_short_name,
    projectName: projectNode?.name ?? p.proj_short_name,
    dataDate: p.last_recalc_date || undefined,
    dataDateMs: parseDate(p.last_recalc_date),
    plannedStart: p.plan_start_date || undefined,
    mustFinishBy: p.plan_end_date || undefined,
    scheduledFinish: p.scd_end_date || undefined,
    activities,
    byId,
    byTaskId,
    relationships,
    wbs,
    hasResources,
  };
  perFile.set(p.proj_id, schedule);
  return schedule;
}

function wbsNamePath(wbs: Map<string, WbsNode>, id: string): string {
  const names: string[] = [];
  let node = wbs.get(id);
  for (let i = 0; node && !node.isProjectNode && i < 50; i++) {
    names.unshift(node.name);
    node = wbs.get(node.parentId);
  }
  return names.join(" > ");
}

export const isComplete = (a: Activity) => a.status === "Completed";
export const isMilestone = (a: Activity) => a.type === "Start Milestone" || a.type === "Finish Milestone";
export const isSummaryType = (a: Activity) => a.type === "Level of Effort" || a.type === "WBS Summary";

export function findActivity(s: Schedule, id: string): Activity {
  const a = s.byId.get(id) ?? s.byTaskId.get(id) ?? s.activities.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!a) throw new XerError(`Activity "${id}" is not in project ${s.projectCode}.`);
  return a;
}

/** Compact representation for listing. */
export function brief(a: Activity) {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    type: a.type,
    wbs: a.wbsCode,
    originalDuration: a.originalDurationDays,
    remainingDuration: a.remainingDurationDays,
    start: a.start,
    finish: a.finish,
    totalFloat: a.totalFloatDays,
    percentComplete: a.percentComplete,
  };
}

/** Full representation of one activity. */
export function detail(a: Activity) {
  const rel = (r: Relationship, other: Activity) => ({
    id: other.id,
    name: other.name,
    type: r.type,
    lag: r.lagDays,
    status: other.status,
    start: other.start,
    finish: other.finish,
    totalFloat: other.totalFloatDays,
  });
  return {
    ...brief(a),
    wbsPath: a.wbsPath,
    calendar: a.calendar,
    hoursPerDay: a.hoursPerDay,
    freeFloat: a.freeFloatDays,
    actualStart: a.actualStart,
    actualFinish: a.actualFinish,
    earlyStart: a.earlyStart,
    earlyFinish: a.earlyFinish,
    lateStart: a.lateStart,
    lateFinish: a.lateFinish,
    plannedStart: a.plannedStart,
    plannedFinish: a.plannedFinish,
    constraint: a.constraint ? { type: a.constraint, date: a.constraintDate } : undefined,
    secondaryConstraint: a.secondaryConstraint ? { type: a.secondaryConstraint, date: a.secondaryConstraintDate } : undefined,
    onLongestPath: a.longestPath,
    predecessors: a.preds.map((r) => rel(r, r.pred)),
    successors: a.succs.map((r) => rel(r, r.succ)),
    resources: a.assignments,
  };
}

export { HOUR, DAY, round };
