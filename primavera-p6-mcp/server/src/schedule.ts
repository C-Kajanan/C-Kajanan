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

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const hrs = (row: Row, field: string) => num(row[field]);

export function listProjects(xer: XerFile) {
  const wbs = table(xer, "PROJWBS");
  return table(xer, "PROJECT").map((row) => ({
    projectId: row.proj_id,
    code: row.proj_short_name,
    name: wbs.find((record) => record.proj_id === row.proj_id && record.proj_node_flag === "Y")?.wbs_name ?? row.proj_short_name,
    exported: row.export_flag !== "N",
    dataDate: row.last_recalc_date || undefined,
    activityCount: table(xer, "TASK").filter((record) => record.proj_id === row.proj_id).length,
  }));
}

function pickProject(xer: XerFile, project?: string): Row {
  const projects = table(xer, "PROJECT");
  if (projects.length === 0) throw new XerError(`${xer.path} has no PROJECT table.`);
  if (project) {
    const row = projects.find(
      (record) => record.proj_short_name === project || record.proj_id === project || record.proj_short_name.toLowerCase() === project.toLowerCase(),
    );
    if (!row) throw new XerError(`Project "${project}" is not in ${xer.path}. Available: ${projects.map((record) => record.proj_short_name).join(", ")}`);
    return row;
  }
  const exported = projects.filter((row) => row.export_flag !== "N");
  if (exported.length === 1) return exported[0];
  if (projects.length === 1) return projects[0];
  throw new XerError(
    `${xer.path} contains ${projects.length} projects; pass "project" with one of: ${projects.map((row) => row.proj_short_name).join(", ")}`,
  );
}

const scheduleCache = new WeakMap<XerFile, Map<string, Schedule>>();

export function buildSchedule(xer: XerFile, project?: string): Schedule {
  const row = pickProject(xer, project);
  let perFile = scheduleCache.get(xer);
  if (!perFile) scheduleCache.set(xer, (perFile = new Map()));
  const cached = perFile.get(row.proj_id);
  if (cached) return cached;

  const calendars = new Map(table(xer, "CALENDAR").map((record) => [record.clndr_id, record]));
  const projCalendar = calendars.get(row.clndr_id);
  const defaultHpd = num(projCalendar?.day_hr_cnt) || 8;

  // WBS with full code paths.
  const wbsRows = table(xer, "PROJWBS").filter((record) => record.proj_id === row.proj_id);
  const wbs = new Map<string, WbsNode>();
  for (const record of wbsRows) {
    wbs.set(record.wbs_id, {
      wbsId: record.wbs_id,
      parentId: record.parent_wbs_id,
      code: record.wbs_short_name,
      name: record.wbs_name,
      path: "",
      seq: num(record.seq_num) ?? 0,
      isProjectNode: record.proj_node_flag === "Y",
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
  const projectNode = [...wbs.values()].find((node) => node.isProjectNode);

  const activities: Activity[] = [];
  for (const task of table(xer, "TASK")) {
    if (task.proj_id !== row.proj_id) continue;
    const cal = calendars.get(task.clndr_id);
    const hpd = num(cal?.day_hr_cnt) || defaultHpd;
    const hpw = num(cal?.week_hr_cnt) || hpd * 5;
    const days = (field: string) => {
      const hours = hrs(task, field);
      return hours === undefined ? undefined : round(hours / hpd);
    };
    const orig = days("target_drtn_hr_cnt") ?? 0;
    const remain = days("remain_drtn_hr_cnt") ?? 0;
    let pct = (num(task.phys_complete_pct) ?? 0) / 100;
    if (task.complete_pct_type === "CP_Drtn") pct = orig > 0 ? Math.max(0, Math.min(1, (orig - remain) / orig)) : task.status_code === "TK_Complete" ? 1 : 0;
    if (task.status_code === "TK_Complete") pct = 1;

    const start = task.act_start_date || task.restart_date || task.early_start_date || task.target_start_date || undefined;
    const finish = task.act_end_date || task.reend_date || task.early_end_date || task.target_end_date || undefined;
    const node = wbs.get(task.wbs_id);
    activities.push({
      taskId: task.task_id,
      id: task.task_code,
      name: task.task_name,
      type: TASK_TYPES[task.task_type] ?? task.task_type,
      status: STATUSES[task.status_code] ?? task.status_code,
      wbsId: task.wbs_id,
      wbsCode: node?.path ?? "",
      wbsPath: wbsNamePath(wbs, task.wbs_id),
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
      actualStart: task.act_start_date || undefined,
      actualFinish: task.act_end_date || undefined,
      earlyStart: task.early_start_date || undefined,
      earlyFinish: task.early_end_date || undefined,
      lateStart: task.late_start_date || undefined,
      lateFinish: task.late_end_date || undefined,
      plannedStart: task.target_start_date || undefined,
      plannedFinish: task.target_end_date || undefined,
      constraintCode: task.cstr_type || undefined,
      constraint: task.cstr_type ? (CONSTRAINTS[task.cstr_type] ?? task.cstr_type) : undefined,
      constraintDate: task.cstr_date || undefined,
      secondaryConstraintCode: task.cstr_type2 || undefined,
      secondaryConstraint: task.cstr_type2 ? (CONSTRAINTS[task.cstr_type2] ?? task.cstr_type2) : undefined,
      secondaryConstraintDate: task.cstr_date2 || undefined,
      longestPath: task.driving_path_flag === "Y",
      preds: [],
      succs: [],
      assignments: [],
      row: task,
    });
  }
  const byTaskId = new Map(activities.map((activity) => [activity.taskId, activity]));
  const byId = new Map(activities.map((activity) => [activity.id, activity]));

  const relationships: Relationship[] = [];
  for (const link of table(xer, "TASKPRED")) {
    const succ = byTaskId.get(link.task_id);
    const pred = byTaskId.get(link.pred_task_id);
    if (!succ || !pred) continue; // relationship to another project
    const rel: Relationship = {
      pred,
      succ,
      type: REL_TYPES[link.pred_type] ?? link.pred_type,
      lagDays: round((num(link.lag_hr_cnt) ?? 0) / succ.hoursPerDay),
    };
    relationships.push(rel);
    pred.succs.push(rel);
    succ.preds.push(rel);
  }

  const resources = new Map(table(xer, "RSRC").map((resource) => [resource.rsrc_id, resource]));
  const rsrcTypes: Record<string, string> = { RT_Labor: "Labor", RT_Equip: "Nonlabor", RT_Mat: "Material" };
  let hasResources = false;
  for (const tr of table(xer, "TASKRSRC")) {
    const activity = byTaskId.get(tr.task_id);
    if (!activity) continue;
    hasResources = true;
    const rsrc = resources.get(tr.rsrc_id);
    activity.assignments.push({
      resourceId: rsrc?.rsrc_short_name ?? tr.rsrc_id,
      resourceName: rsrc?.rsrc_name ?? "",
      resourceType: rsrcTypes[rsrc?.rsrc_type ?? ""] ?? rsrc?.rsrc_type ?? "",
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
    projectId: row.proj_id,
    projectCode: row.proj_short_name,
    projectName: projectNode?.name ?? row.proj_short_name,
    dataDate: row.last_recalc_date || undefined,
    dataDateMs: parseDate(row.last_recalc_date),
    plannedStart: row.plan_start_date || undefined,
    mustFinishBy: row.plan_end_date || undefined,
    scheduledFinish: row.scd_end_date || undefined,
    activities,
    byId,
    byTaskId,
    relationships,
    wbs,
    hasResources,
  };
  perFile.set(row.proj_id, schedule);
  return schedule;
}

function wbsNamePath(wbs: Map<string, WbsNode>, id: string): string {
  const names: string[] = [];
  let node = wbs.get(id);
  for (let index = 0; node && !node.isProjectNode && index < 50; index++) {
    names.unshift(node.name);
    node = wbs.get(node.parentId);
  }
  return names.join(" > ");
}

export const isComplete = (activity: Activity) => activity.status === "Completed";
export const isMilestone = (activity: Activity) => activity.type === "Start Milestone" || activity.type === "Finish Milestone";
export const isSummaryType = (activity: Activity) => activity.type === "Level of Effort" || activity.type === "WBS Summary";

export function findActivity(schedule: Schedule, id: string): Activity {
  const activity = schedule.byId.get(id) ?? schedule.byTaskId.get(id) ?? schedule.activities.find((other) => other.id.toLowerCase() === id.toLowerCase());
  if (!activity) throw new XerError(`Activity "${id}" is not in project ${schedule.projectCode}.`);
  return activity;
}

/** Compact representation for listing. */
export function brief(activity: Activity) {
  return {
    id: activity.id,
    name: activity.name,
    status: activity.status,
    type: activity.type,
    wbs: activity.wbsCode,
    originalDuration: activity.originalDurationDays,
    remainingDuration: activity.remainingDurationDays,
    start: activity.start,
    finish: activity.finish,
    totalFloat: activity.totalFloatDays,
    percentComplete: activity.percentComplete,
  };
}

/** Full representation of one activity. */
export function detail(activity: Activity) {
  const rel = (link: Relationship, other: Activity) => ({
    id: other.id,
    name: other.name,
    type: link.type,
    lag: link.lagDays,
    status: other.status,
    start: other.start,
    finish: other.finish,
    totalFloat: other.totalFloatDays,
  });
  return {
    ...brief(activity),
    wbsPath: activity.wbsPath,
    calendar: activity.calendar,
    hoursPerDay: activity.hoursPerDay,
    freeFloat: activity.freeFloatDays,
    actualStart: activity.actualStart,
    actualFinish: activity.actualFinish,
    earlyStart: activity.earlyStart,
    earlyFinish: activity.earlyFinish,
    lateStart: activity.lateStart,
    lateFinish: activity.lateFinish,
    plannedStart: activity.plannedStart,
    plannedFinish: activity.plannedFinish,
    constraint: activity.constraint ? { type: activity.constraint, date: activity.constraintDate } : undefined,
    secondaryConstraint: activity.secondaryConstraint ? { type: activity.secondaryConstraint, date: activity.secondaryConstraintDate } : undefined,
    onLongestPath: activity.longestPath,
    predecessors: activity.preds.map((link) => rel(link, link.pred)),
    successors: activity.succs.map((link) => rel(link, link.succ)),
    resources: activity.assignments,
  };
}

export { HOUR, DAY, round };
