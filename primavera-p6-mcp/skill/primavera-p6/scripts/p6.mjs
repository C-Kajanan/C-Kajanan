#!/usr/bin/env node

// build/skill/p6.js
import { readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath } from "node:url";

// build/tools/xerHandlers.js
import { readdirSync, statSync as statSync2 } from "node:fs";
import { join, resolve } from "node:path";

// build/xer.js
import { readFileSync, statSync } from "node:fs";
var XerError = class extends Error {
};
function decodeXer(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
function parseXer(text, path = "<memory>") {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").split("	");
  if (header[0] !== "ERMHDR") {
    throw new XerError(`${path} is not an XER file (first line should start with ERMHDR).`);
  }
  const tables = /* @__PURE__ */ new Map();
  let fields = [];
  let rows;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line)
      continue;
    const tag = line.slice(0, 2);
    const parts = line.split("	");
    if (tag === "%T") {
      rows = [];
      fields = [];
      tables.set(parts[1].trim(), rows);
    } else if (tag === "%F") {
      fields = parts.slice(1).map((field) => field.trim());
    } else if (tag === "%R" && rows) {
      const row = {};
      for (let col = 0; col < fields.length; col++)
        row[fields[col]] = parts[col + 1] ?? "";
      rows.push(row);
    } else if (tag === "%E") {
      break;
    }
  }
  return { path, version: header[1] ?? "", exportDate: header[2] ?? "", exportUser: header[4] ?? "", tables };
}
var cache = /* @__PURE__ */ new Map();
function loadXer(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new XerError(`File not found: ${path}`);
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
    return hit.xer;
  const xer = parseXer(decodeXer(readFileSync(path)), path);
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, xer });
  return xer;
}
function table(xer, name) {
  return xer.tables.get(name) ?? [];
}
function parseDate(value) {
  if (!value)
    return void 0;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match)
    return void 0;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], match[4] ? +match[4] : 0, match[5] ? +match[5] : 0);
}
function num(value) {
  if (value === void 0 || value === "")
    return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}

// build/schedule.js
var HOUR = 36e5;
var DAY = 24 * HOUR;
var TASK_TYPES = {
  TT_Task: "Task Dependent",
  TT_Rsrc: "Resource Dependent",
  TT_LOE: "Level of Effort",
  TT_Mile: "Start Milestone",
  TT_FinMile: "Finish Milestone",
  TT_WBS: "WBS Summary"
};
var STATUSES = {
  TK_NotStart: "Not Started",
  TK_Active: "In Progress",
  TK_Complete: "Completed"
};
var CONSTRAINTS = {
  CS_ALAP: "As Late As Possible",
  CS_MSO: "Start On",
  CS_MSOA: "Start On or After",
  CS_MSOB: "Start On or Before",
  CS_MEO: "Finish On",
  CS_MEOA: "Finish On or After",
  CS_MEOB: "Finish On or Before",
  CS_MANDSTART: "Mandatory Start",
  CS_MANDFIN: "Mandatory Finish"
};
var HARD_CONSTRAINTS = /* @__PURE__ */ new Set(["CS_MSO", "CS_MEO", "CS_MSOB", "CS_MEOB", "CS_MANDSTART", "CS_MANDFIN"]);
var REL_TYPES = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };
var round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
var hrs = (row, field) => num(row[field]);
function listProjects(xer) {
  const wbs = table(xer, "PROJWBS");
  return table(xer, "PROJECT").map((row) => ({
    projectId: row.proj_id,
    code: row.proj_short_name,
    name: wbs.find((record) => record.proj_id === row.proj_id && record.proj_node_flag === "Y")?.wbs_name ?? row.proj_short_name,
    exported: row.export_flag !== "N",
    dataDate: row.last_recalc_date || void 0,
    activityCount: table(xer, "TASK").filter((record) => record.proj_id === row.proj_id).length
  }));
}
function pickProject(xer, project) {
  const projects = table(xer, "PROJECT");
  if (projects.length === 0)
    throw new XerError(`${xer.path} has no PROJECT table.`);
  if (project) {
    const row = projects.find((record) => record.proj_short_name === project || record.proj_id === project || record.proj_short_name.toLowerCase() === project.toLowerCase());
    if (!row)
      throw new XerError(`Project "${project}" is not in ${xer.path}. Available: ${projects.map((record) => record.proj_short_name).join(", ")}`);
    return row;
  }
  const exported = projects.filter((row) => row.export_flag !== "N");
  if (exported.length === 1)
    return exported[0];
  if (projects.length === 1)
    return projects[0];
  throw new XerError(`${xer.path} contains ${projects.length} projects; pass "project" with one of: ${projects.map((row) => row.proj_short_name).join(", ")}`);
}
var scheduleCache = /* @__PURE__ */ new WeakMap();
function buildSchedule(xer, project) {
  const row = pickProject(xer, project);
  let perFile = scheduleCache.get(xer);
  if (!perFile)
    scheduleCache.set(xer, perFile = /* @__PURE__ */ new Map());
  const cached = perFile.get(row.proj_id);
  if (cached)
    return cached;
  const calendars = new Map(table(xer, "CALENDAR").map((record) => [record.clndr_id, record]));
  const projCalendar = calendars.get(row.clndr_id);
  const defaultHpd = num(projCalendar?.day_hr_cnt) || 8;
  const wbsRows = table(xer, "PROJWBS").filter((record) => record.proj_id === row.proj_id);
  const wbs = /* @__PURE__ */ new Map();
  for (const record of wbsRows) {
    wbs.set(record.wbs_id, {
      wbsId: record.wbs_id,
      parentId: record.parent_wbs_id,
      code: record.wbs_short_name,
      name: record.wbs_name,
      path: "",
      seq: num(record.seq_num) ?? 0,
      isProjectNode: record.proj_node_flag === "Y"
    });
  }
  const pathOf = (id, depth = 0) => {
    const node = wbs.get(id);
    if (!node || node.isProjectNode || depth > 50)
      return "";
    if (node.path)
      return node.path;
    const parent = pathOf(node.parentId, depth + 1);
    node.path = parent ? `${parent}.${node.code}` : node.code;
    return node.path;
  };
  for (const id of wbs.keys())
    pathOf(id);
  const projectNode = [...wbs.values()].find((node) => node.isProjectNode);
  const activities = [];
  for (const task of table(xer, "TASK")) {
    if (task.proj_id !== row.proj_id)
      continue;
    const cal = calendars.get(task.clndr_id);
    const hpd = num(cal?.day_hr_cnt) || defaultHpd;
    const hpw = num(cal?.week_hr_cnt) || hpd * 5;
    const days = (field) => {
      const hours = hrs(task, field);
      return hours === void 0 ? void 0 : round(hours / hpd);
    };
    const orig = days("target_drtn_hr_cnt") ?? 0;
    const remain = days("remain_drtn_hr_cnt") ?? 0;
    let pct2 = (num(task.phys_complete_pct) ?? 0) / 100;
    if (task.complete_pct_type === "CP_Drtn")
      pct2 = orig > 0 ? Math.max(0, Math.min(1, (orig - remain) / orig)) : task.status_code === "TK_Complete" ? 1 : 0;
    if (task.status_code === "TK_Complete")
      pct2 = 1;
    const start = task.act_start_date || task.restart_date || task.early_start_date || task.target_start_date || void 0;
    const finish = task.act_end_date || task.reend_date || task.early_end_date || task.target_end_date || void 0;
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
      percentComplete: round(pct2 * 100, 1),
      start,
      finish,
      startMs: parseDate(start),
      finishMs: parseDate(finish),
      actualStart: task.act_start_date || void 0,
      actualFinish: task.act_end_date || void 0,
      earlyStart: task.early_start_date || void 0,
      earlyFinish: task.early_end_date || void 0,
      lateStart: task.late_start_date || void 0,
      lateFinish: task.late_end_date || void 0,
      plannedStart: task.target_start_date || void 0,
      plannedFinish: task.target_end_date || void 0,
      constraintCode: task.cstr_type || void 0,
      constraint: task.cstr_type ? CONSTRAINTS[task.cstr_type] ?? task.cstr_type : void 0,
      constraintDate: task.cstr_date || void 0,
      secondaryConstraintCode: task.cstr_type2 || void 0,
      secondaryConstraint: task.cstr_type2 ? CONSTRAINTS[task.cstr_type2] ?? task.cstr_type2 : void 0,
      secondaryConstraintDate: task.cstr_date2 || void 0,
      longestPath: task.driving_path_flag === "Y",
      preds: [],
      succs: [],
      assignments: [],
      row: task
    });
  }
  const byTaskId = new Map(activities.map((activity) => [activity.taskId, activity]));
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const relationships = [];
  for (const link of table(xer, "TASKPRED")) {
    const succ = byTaskId.get(link.task_id);
    const pred = byTaskId.get(link.pred_task_id);
    if (!succ || !pred)
      continue;
    const rel = {
      pred,
      succ,
      type: REL_TYPES[link.pred_type] ?? link.pred_type,
      lagDays: round((num(link.lag_hr_cnt) ?? 0) / succ.hoursPerDay)
    };
    relationships.push(rel);
    pred.succs.push(rel);
    succ.preds.push(rel);
  }
  const resources = new Map(table(xer, "RSRC").map((resource) => [resource.rsrc_id, resource]));
  const rsrcTypes = { RT_Labor: "Labor", RT_Equip: "Nonlabor", RT_Mat: "Material" };
  let hasResources = false;
  for (const tr of table(xer, "TASKRSRC")) {
    const activity = byTaskId.get(tr.task_id);
    if (!activity)
      continue;
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
      remainingCost: num(tr.remain_cost) ?? 0
    });
  }
  const schedule = {
    xer,
    projectId: row.proj_id,
    projectCode: row.proj_short_name,
    projectName: projectNode?.name ?? row.proj_short_name,
    dataDate: row.last_recalc_date || void 0,
    dataDateMs: parseDate(row.last_recalc_date),
    plannedStart: row.plan_start_date || void 0,
    mustFinishBy: row.plan_end_date || void 0,
    scheduledFinish: row.scd_end_date || void 0,
    activities,
    byId,
    byTaskId,
    relationships,
    wbs,
    hasResources
  };
  perFile.set(row.proj_id, schedule);
  return schedule;
}
function wbsNamePath(wbs, id) {
  const names = [];
  let node = wbs.get(id);
  for (let index = 0; node && !node.isProjectNode && index < 50; index++) {
    names.unshift(node.name);
    node = wbs.get(node.parentId);
  }
  return names.join(" > ");
}
var isComplete = (activity) => activity.status === "Completed";
var isMilestone = (activity) => activity.type === "Start Milestone" || activity.type === "Finish Milestone";
var isSummaryType = (activity) => activity.type === "Level of Effort" || activity.type === "WBS Summary";
function findActivity(schedule, id) {
  const activity = schedule.byId.get(id) ?? schedule.byTaskId.get(id) ?? schedule.activities.find((other) => other.id.toLowerCase() === id.toLowerCase());
  if (!activity)
    throw new XerError(`Activity "${id}" is not in project ${schedule.projectCode}.`);
  return activity;
}
function brief(activity) {
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
    percentComplete: activity.percentComplete
  };
}
function detail(activity) {
  const rel = (link, other) => ({
    id: other.id,
    name: other.name,
    type: link.type,
    lag: link.lagDays,
    status: other.status,
    start: other.start,
    finish: other.finish,
    totalFloat: other.totalFloatDays
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
    constraint: activity.constraint ? { type: activity.constraint, date: activity.constraintDate } : void 0,
    secondaryConstraint: activity.secondaryConstraint ? { type: activity.secondaryConstraint, date: activity.secondaryConstraintDate } : void 0,
    onLongestPath: activity.longestPath,
    predecessors: activity.preds.map((link) => rel(link, link.pred)),
    successors: activity.succs.map((link) => rel(link, link.succ)),
    resources: activity.assignments
  };
}

// build/analysis.js
var pct = (value, day) => day === 0 ? 0 : round(value / day * 100, 1);
var byStart = (activity, other) => (activity.startMs ?? Infinity) - (other.startMs ?? Infinity) || (activity.finishMs ?? Infinity) - (other.finishMs ?? Infinity) || activity.id.localeCompare(other.id);
function latestFinish(acts) {
  const rank = (activity) => (activity.type === "Finish Milestone" ? 2 : 0) + (activity.succs.length === 0 ? 1 : 0);
  let best;
  for (const activity of acts) {
    if (activity.finishMs === void 0)
      continue;
    if (!best || activity.finishMs > best.finishMs || activity.finishMs === best.finishMs && rank(activity) > rank(best))
      best = activity;
  }
  return best;
}
function earliestStart(acts) {
  let best;
  for (const activity of acts)
    if (activity.startMs !== void 0 && (!best || activity.startMs < best.startMs))
      best = activity;
  return best;
}
function summary(schedule, criticalFloatDays = 0) {
  const acts = schedule.activities;
  const count = (field) => acts.filter(field).length;
  const byStatus = {};
  const byType = {};
  for (const activity of acts) {
    byStatus[activity.status] = (byStatus[activity.status] ?? 0) + 1;
    byType[activity.type] = (byType[activity.type] ?? 0) + 1;
  }
  const work = acts.filter((activity) => !isSummaryType(activity));
  const totalOrig = work.reduce((value, activity) => value + activity.originalDurationDays, 0);
  const earned = work.reduce((value, activity) => value + activity.originalDurationDays * (activity.percentComplete / 100), 0);
  const finishAct = latestFinish(acts);
  const startAct = earliestStart(acts);
  const cost = acts.flatMap((activity) => activity.assignments).reduce((item, assignment) => ({ planned: item.planned + assignment.plannedCost, actual: item.actual + assignment.actualCost, remaining: item.remaining + assignment.remainingCost }), { planned: 0, actual: 0, remaining: 0 });
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
    finishActivity: finishAct ? { id: finishAct.id, name: finishAct.name } : void 0,
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
    cost: schedule.hasResources ? { planned: round(cost.planned), actual: round(cost.actual), remaining: round(cost.remaining) } : void 0
  };
}
function filterActivities(schedule, field) {
  const startsAfter = parseDate(field.startsAfter);
  const finishesBefore = parseDate(field.finishesBefore);
  const search = field.search?.toLowerCase();
  const wbs = field.wbs?.toLowerCase();
  const resource = field.resource?.toLowerCase();
  const types = field.types?.map((item) => item.toLowerCase());
  return schedule.activities.filter((activity) => {
    if (field.status?.length && !field.status.includes(activity.status))
      return false;
    if (types?.length && !types.some((item) => activity.type.toLowerCase().includes(item)))
      return false;
    if (wbs && !activity.wbsCode.toLowerCase().startsWith(wbs) && !activity.wbsPath.toLowerCase().includes(wbs))
      return false;
    if (search && !activity.id.toLowerCase().includes(search) && !activity.name.toLowerCase().includes(search))
      return false;
    if (field.maxFloat !== void 0 && !((activity.totalFloatDays ?? Infinity) <= field.maxFloat))
      return false;
    if (field.minFloat !== void 0 && !((activity.totalFloatDays ?? -Infinity) >= field.minFloat))
      return false;
    if (field.longestPathOnly && !activity.longestPath)
      return false;
    if (startsAfter !== void 0 && !((activity.startMs ?? -Infinity) >= startsAfter))
      return false;
    if (finishesBefore !== void 0 && !((activity.finishMs ?? Infinity) <= finishesBefore))
      return false;
    if (field.hasConstraint !== void 0 && Boolean(activity.constraintCode) !== field.hasConstraint)
      return false;
    if (resource && !activity.assignments.some((assignment) => assignment.resourceId.toLowerCase().includes(resource) || assignment.resourceName.toLowerCase().includes(resource)))
      return false;
    return true;
  }).sort(byStart);
}
function criticalPath(schedule, floatThreshold = 0, includeCompleted = false) {
  const acts = schedule.activities.filter((activity) => (includeCompleted || !isComplete(activity)) && !isSummaryType(activity)).filter((activity) => (activity.totalFloatDays ?? Infinity) <= floatThreshold || floatThreshold <= 0 && activity.longestPath && !isComplete(activity)).sort(byStart);
  return {
    project: schedule.projectCode,
    dataDate: schedule.dataDate,
    floatThreshold,
    count: acts.length,
    note: "Activities whose total float is at or below the threshold, plus those P6 flagged as on the longest path, ordered by start.",
    activities: acts.map((activity) => ({ ...brief(activity), onLongestPath: activity.longestPath }))
  };
}
function workPos(ms, workDaysPerWeek) {
  const day = Math.floor(ms / DAY);
  const endOfDay = (ms - day * DAY) / HOUR >= 12 ? 1 : 0;
  if (workDaysPerWeek >= 7)
    return day + endOfDay;
  const fromMonday = day + 3;
  const week = Math.floor(fromMonday / 7);
  const weekday = fromMonday - week * 7;
  return week * 5 + Math.min(weekday, 5) + (weekday < 5 ? endOfDay : 0);
}
function relGap(rel) {
  const { pred, succ } = rel;
  const base = rel.type === "SS" || rel.type === "SF" ? pred.startMs : pred.finishMs;
  const target = rel.type === "FF" || rel.type === "SF" ? succ.finishMs : succ.startMs;
  if (base === void 0 || target === void 0)
    return void 0;
  const wd = succ.workDaysPerWeek;
  return workPos(target, wd) - workPos(base, wd) - rel.lagDays;
}
function drivingPath(schedule, target, maxSteps = 500) {
  const path = [{ activity: target }];
  const seen = /* @__PURE__ */ new Set([target.taskId]);
  let current = target;
  for (let index = 0; index < maxSteps; index++) {
    if (isComplete(current) || current.actualStart)
      break;
    let best;
    for (const rel of current.preds) {
      if (seen.has(rel.pred.taskId))
        continue;
      const gap = relGap(rel);
      if (gap === void 0)
        continue;
      if (!best || gap < best.gap)
        best = { r: rel, gap };
    }
    if (!best)
      break;
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
    path: path.reverse().map(({ activity, via, gap }) => ({ ...brief(activity), drives: via ? { successor: via.succ.id, type: via.type, lag: via.lagDays, gapDays: gap } : void 0 }))
  };
}
function lookahead(schedule, days, from) {
  const fromMs = parseDate(from) ?? schedule.dataDateMs ?? Date.now();
  const toMs = fromMs + days * DAY;
  const acts = schedule.activities.filter((activity) => !isComplete(activity) && !isSummaryType(activity)).filter((activity) => (activity.startMs ?? Infinity) < toMs && (activity.finishMs ?? -Infinity) >= fromMs).sort(byStart);
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  return {
    project: schedule.projectCode,
    window: { from: fmt(fromMs), to: fmt(toMs), days },
    starting: acts.filter((activity) => !activity.actualStart && (activity.startMs ?? Infinity) >= fromMs).length,
    inProgress: acts.filter((activity) => activity.actualStart).length,
    finishing: acts.filter((activity) => (activity.finishMs ?? Infinity) < toMs).length,
    activities: acts.map((activity) => ({ ...brief(activity), resources: activity.assignments.map((assignment) => assignment.resourceId) }))
  };
}
function wbsTree(schedule, maxDepth = 10) {
  const children = /* @__PURE__ */ new Map();
  for (const node of schedule.wbs.values()) {
    if (!children.has(node.parentId))
      children.set(node.parentId, []);
    children.get(node.parentId).push(node.wbsId);
  }
  const actsByWbs = /* @__PURE__ */ new Map();
  for (const activity of schedule.activities) {
    if (!actsByWbs.has(activity.wbsId))
      actsByWbs.set(activity.wbsId, []);
    actsByWbs.get(activity.wbsId).push(activity);
  }
  const all = (id) => [...actsByWbs.get(id) ?? [], ...(children.get(id) ?? []).flatMap(all)];
  const build = (id, depth) => {
    const node = schedule.wbs.get(id);
    const acts = all(id);
    const floats = acts.filter((activity) => !isComplete(activity) && activity.totalFloatDays !== void 0).map((activity) => activity.totalFloatDays);
    const kids = (children.get(id) ?? []).map((key) => schedule.wbs.get(key)).sort((wbsNode, child) => wbsNode.seq - child.seq || wbsNode.code.localeCompare(child.code));
    return {
      code: node.isProjectNode ? schedule.projectCode : node.path,
      name: node.name,
      activities: acts.length,
      start: earliestStart(acts)?.start,
      finish: latestFinish(acts)?.finish,
      minFloat: floats.length ? Math.min(...floats) : void 0,
      children: depth < maxDepth && kids.length ? kids.map((wbsNode) => build(wbsNode.wbsId, depth + 1)) : void 0
    };
  };
  const root = [...schedule.wbs.values()].find((node) => node.isProjectNode);
  if (root)
    return build(root.wbsId, 0);
  return { code: schedule.projectCode, name: schedule.projectName, children: [...schedule.wbs.values()].filter((node) => !schedule.wbs.has(node.parentId)).map((node) => build(node.wbsId, 1)) };
}
function resourceSummary(schedule) {
  const totals = /* @__PURE__ */ new Map();
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
    remainingCost: round(item.remainingCost)
  }));
  return {
    project: schedule.projectCode,
    note: "Units are hours for labor and nonlabor resources and the resource's unit of measure for material.",
    resources: list.sort((first, second) => second.planned - first.planned),
    unassignedResources: table(schedule.xer, "RSRC").filter((row) => !totals.has(row.rsrc_short_name)).map((row) => row.rsrc_short_name)
  };
}
var ids = (acts, max = 25) => acts.slice(0, max).map((activity) => `${activity.id} ${activity.name}`);
var relIds = (rels, max = 25) => rels.slice(0, max).map((rel) => `${rel.pred.id} -> ${rel.succ.id} ${rel.type} lag ${rel.lagDays}d`);
function dcmaCheck(schedule, baseline) {
  const dd = schedule.dataDateMs;
  const incomplete = schedule.activities.filter((activity) => !isComplete(activity) && !isSummaryType(activity));
  const tasks = incomplete.filter((activity) => !isMilestone(activity));
  const rels = schedule.relationships.filter((rel) => !isComplete(rel.succ) && !isSummaryType(rel.succ) && !isSummaryType(rel.pred));
  const checks = [];
  const add = (check) => checks.push(check);
  const ratio = (id, name, items, of, limit, note, cmp = "max") => {
    const value = pct(items.length, of);
    add({
      id,
      name,
      metric: `% of ${of} activities`,
      threshold: cmp === "max" ? limit === 0 ? "0%" : `<= ${limit}%` : `>= ${limit}%`,
      value,
      pass: of === 0 ? null : cmp === "max" ? value <= limit : value >= limit,
      count: items.length,
      of,
      examples: ids(items),
      note
    });
  };
  const noPred = incomplete.filter((activity) => activity.preds.length === 0);
  const noSucc = incomplete.filter((activity) => activity.succs.length === 0);
  const openEnds = [.../* @__PURE__ */ new Set([...noPred, ...noSucc])];
  ratio(1, "Logic (missing predecessors or successors)", openEnds, incomplete.length, 5, `${noPred.length} without predecessors, ${noSucc.length} without successors. The project start and finish milestones are expected to show up here.`);
  const leads = rels.filter((rel) => rel.lagDays < 0);
  const lags = rels.filter((rel) => rel.lagDays > 0);
  const fs = rels.filter((rel) => rel.type === "FS");
  const relCheck = (id, name, items, limit, cmp, note) => {
    const value = pct(items.length, rels.length);
    add({
      id,
      name,
      metric: `% of ${rels.length} relationships`,
      threshold: cmp === "max" ? limit === 0 ? "0%" : `<= ${limit}%` : `>= ${limit}%`,
      value,
      pass: rels.length === 0 ? null : cmp === "max" ? value <= limit : value >= limit,
      count: items.length,
      of: rels.length,
      examples: cmp === "max" ? relIds(items) : relIds(rels.filter((rel) => rel.type !== "FS")),
      note
    });
  };
  relCheck(2, "Leads (negative lag)", leads, 0, "max");
  relCheck(3, "Lags (positive lag)", lags, 5, "max");
  relCheck(4, "Relationship types (finish-to-start)", fs, 90, "min", "Examples list the non-FS relationships.");
  const hard = incomplete.filter((activity) => HARD_CONSTRAINTS.has(activity.constraintCode ?? "") || HARD_CONSTRAINTS.has(activity.secondaryConstraintCode ?? ""));
  ratio(5, "Hard constraints", hard, incomplete.length, 5, "Start On, Finish On, Start/Finish On or Before, Mandatory Start and Mandatory Finish.");
  ratio(6, "High float (total float > 44 days)", incomplete.filter((activity) => (activity.totalFloatDays ?? 0) > 44), incomplete.length, 5);
  ratio(7, "Negative float", incomplete.filter((activity) => (activity.totalFloatDays ?? 0) < 0), incomplete.length, 0);
  ratio(8, "High duration (original duration > 44 days)", tasks.filter((activity) => activity.originalDurationDays > 44), tasks.length, 5, "Milestones excluded.");
  if (dd === void 0) {
    add({ id: 9, name: "Invalid dates", metric: "count", threshold: "0", value: null, pass: null, note: "The project has no data date." });
  } else {
    const invalid = schedule.activities.filter((activity) => {
      const as = parseDate(activity.actualStart);
      const af = parseDate(activity.actualFinish);
      if (as !== void 0 && as > dd || af !== void 0 && af > dd)
        return true;
      if (isComplete(activity))
        return false;
      if (!activity.actualStart && (parseDate(activity.earlyStart) ?? Infinity) < dd)
        return true;
      return (parseDate(activity.earlyFinish) ?? Infinity) < dd;
    });
    add({
      id: 9,
      name: "Invalid dates",
      metric: "count",
      threshold: "0",
      value: invalid.length,
      pass: invalid.length === 0,
      count: invalid.length,
      of: schedule.activities.length,
      examples: ids(invalid),
      note: "Actual dates after the data date, or forecast dates before it."
    });
  }
  if (!schedule.hasResources) {
    add({ id: 10, name: "Resources", metric: "% of activities", threshold: "0%", value: null, pass: null, note: "The schedule has no resource assignments, so this check doesn't apply." });
  } else {
    ratio(10, "Resources (activities with duration but no resources)", tasks.filter((activity) => activity.originalDurationDays > 0 && activity.assignments.length === 0), tasks.length, 0);
  }
  const baseFinish = (activity) => {
    if (!baseline)
      return parseDate(activity.plannedFinish);
    const other = baseline.byId.get(activity.id);
    return other?.finishMs;
  };
  const baseSource = baseline ? `baseline ${baseline.xer.path}` : "planned (target) dates, because no baseline was given";
  if (dd === void 0) {
    add({ id: 11, name: "Missed tasks", metric: "%", threshold: "<= 5%", value: null, pass: null, note: "The project has no data date." });
    add({ id: 14, name: "Baseline Execution Index (BEI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "The project has no data date." });
  } else {
    const work = schedule.activities.filter((activity) => !isSummaryType(activity));
    const dueByNow = work.filter((activity) => (baseFinish(activity) ?? Infinity) <= dd);
    const missed = dueByNow.filter((activity) => !isComplete(activity) || (parseDate(activity.actualFinish) ?? Infinity) > baseFinish(activity));
    ratio(11, "Missed tasks", missed, dueByNow.length, 5, `Compared with ${baseSource}.`);
    const completed = work.filter(isComplete).length;
    const bei = dueByNow.length === 0 ? null : round(completed / dueByNow.length, 2);
    add({
      id: 14,
      name: "Baseline Execution Index (BEI)",
      metric: "completed / due by data date",
      threshold: ">= 0.95",
      value: bei,
      pass: bei === null ? null : bei >= 0.95,
      count: completed,
      of: dueByNow.length,
      note: `Compared with ${baseSource}.`
    });
  }
  const finishAct = latestFinish(incomplete);
  if (!finishAct) {
    add({ id: 12, name: "Critical path test", metric: "pass/fail", threshold: "continuous path", value: null, pass: null, note: "No incomplete activities." });
    add({ id: 13, name: "Critical Path Length Index (CPLI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "No incomplete activities." });
  } else {
    const trace = drivingPath(schedule, finishAct);
    const first = trace.path[0];
    const firstAct = schedule.byId.get(first.id);
    const reachesStart = Boolean(firstAct.actualStart) || firstAct.preds.length === 0 && (dd === void 0 || (firstAct.startMs ?? Infinity) - dd <= DAY);
    const breaks = trace.path.filter((part) => part.drives && Math.abs(part.drives.gapDays ?? 0) > 1);
    add({
      id: 12,
      name: "Critical path test",
      metric: "driving path from the data date to the project finish",
      threshold: "continuous path",
      value: `${trace.steps} activities, ${breaks.length} gaps over 1 day`,
      pass: reachesStart && breaks.length === 0,
      examples: trace.path.map((part) => `${part.id} ${part.name}${part.drives ? ` -(${part.drives.type}, gap ${part.drives.gapDays}d)->` : ""}`).slice(0, 40),
      note: "Approximation from exported dates: DCMA's version of this test delays a critical activity and checks that the finish moves by the same amount, which needs P6 to reschedule. Rescheduling in P6 (or p6_schedule_project in the MCP server) gives the exact result."
    });
    if (dd === void 0 || finishAct.finishMs === void 0) {
      add({ id: 13, name: "Critical Path Length Index (CPLI)", metric: "ratio", threshold: ">= 0.95", value: null, pass: null, note: "The project has no data date." });
    } else {
      const cpl = workPos(finishAct.finishMs, finishAct.workDaysPerWeek) - workPos(dd, finishAct.workDaysPerWeek);
      const tf = finishAct.totalFloatDays ?? 0;
      const cpli = cpl <= 0 ? null : round((cpl + tf) / cpl, 2);
      add({
        id: 13,
        name: "Critical Path Length Index (CPLI)",
        metric: "(CPL + TF) / CPL",
        threshold: ">= 0.95",
        value: cpli,
        pass: cpli === null ? null : cpli >= 0.95,
        note: `Critical path length ${round(cpl, 1)} working days from the data date to ${finishAct.id} (${finishAct.finish}), total float ${tf} days.`
      });
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
    checks
  };
}
var daysBetween = (first, second) => first === void 0 || second === void 0 ? void 0 : round((second - first) / DAY, 1);
var relKey = (rel) => `${rel.pred.id}|${rel.succ.id}|${rel.type}`;
function compareSchedules(prev, curr, limit = 100) {
  const added = curr.activities.filter((activity) => !prev.byId.has(activity.id));
  const removed = prev.activities.filter((activity) => !curr.byId.has(activity.id));
  const changed = [];
  for (const activity of curr.activities) {
    const other = prev.byId.get(activity.id);
    if (!other)
      continue;
    const diff = {};
    if (activity.name !== other.name)
      diff.name = { from: other.name, to: activity.name };
    if (activity.status !== other.status)
      diff.status = { from: other.status, to: activity.status };
    if (activity.originalDurationDays !== other.originalDurationDays)
      diff.originalDuration = { from: other.originalDurationDays, to: activity.originalDurationDays };
    if (activity.constraintCode !== other.constraintCode || activity.constraintDate !== other.constraintDate)
      diff.constraint = { from: other.constraint ? `${other.constraint} ${other.constraintDate ?? ""}`.trim() : null, to: activity.constraint ? `${activity.constraint} ${activity.constraintDate ?? ""}`.trim() : null };
    const startSlip = daysBetween(other.startMs, activity.startMs);
    const finishSlip = daysBetween(other.finishMs, activity.finishMs);
    if (startSlip)
      diff.startSlipDays = startSlip;
    if (finishSlip)
      diff.finishSlipDays = finishSlip;
    if (activity.totalFloatDays !== other.totalFloatDays)
      diff.totalFloat = { from: other.totalFloatDays, to: activity.totalFloatDays };
    if (Object.keys(diff).length)
      changed.push({ id: activity.id, name: activity.name, finish: activity.finish, ...diff });
  }
  changed.sort((item, other) => Math.abs(Number(other.finishSlipDays ?? 0)) - Math.abs(Number(item.finishSlipDays ?? 0)));
  const prevRels = new Map(prev.relationships.map((rel) => [relKey(rel), rel]));
  const currRels = new Map(curr.relationships.map((rel) => [relKey(rel), rel]));
  const relDesc = (rel) => `${rel.pred.id} -> ${rel.succ.id} ${rel.type}${rel.lagDays ? ` lag ${rel.lagDays}d` : ""}`;
  const logicAdded = [...currRels.entries()].filter(([key]) => !prevRels.has(key)).map(([, rel]) => relDesc(rel));
  const logicRemoved = [...prevRels.entries()].filter(([key]) => !currRels.has(key)).map(([, rel]) => relDesc(rel));
  const lagChanged = [...currRels.entries()].filter(([key, rel]) => prevRels.has(key) && prevRels.get(key).lagDays !== rel.lagDays).map(([key, rel]) => `${relDesc(rel)} (was ${prevRels.get(key).lagDays}d)`);
  const pf = latestFinish(prev.activities);
  const cf = latestFinish(curr.activities);
  const progressed = curr.activities.filter((activity) => {
    const other = prev.byId.get(activity.id);
    return other && activity.percentComplete > other.percentComplete;
  });
  const cut = (xs) => xs.slice(0, limit);
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
      newlyCompleted: curr.activities.filter((activity) => isComplete(activity) && prev.byId.get(activity.id) && !isComplete(prev.byId.get(activity.id))).length,
      newlyStarted: curr.activities.filter((activity) => activity.actualStart && prev.byId.get(activity.id) && !prev.byId.get(activity.id).actualStart).length,
      logicAdded: logicAdded.length,
      logicRemoved: logicRemoved.length,
      lagChanged: lagChanged.length
    },
    added: cut(added.map(brief)),
    removed: cut(removed.map(brief)),
    changed: cut(changed),
    logicAdded: cut(logicAdded),
    logicRemoved: cut(logicRemoved),
    lagChanged: cut(lagChanged),
    truncatedTo: limit
  };
}

// build/tools/types.js
function page(items, limit, offset = 0) {
  return {
    total: items.length,
    offset,
    returned: Math.max(0, Math.min(limit, items.length - offset)),
    truncated: offset + limit < items.length,
    items: items.slice(offset, offset + limit)
  };
}

// build/tools/xerHandlers.js
function createXerHandlers(baseDir) {
  const pathOf = (path) => resolve(baseDir(), path);
  const scheduleOf = (args) => buildSchedule(loadXer(pathOf(args.file)), args.project);
  return {
    xer_list_files(args) {
      const root = resolve(baseDir(), args.folder ?? ".");
      const found = [];
      const walk = (dir, depth) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          throw new XerError(`Can't read folder ${dir}`);
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory() && args.recursive && depth < 6 && !entry.name.startsWith("."))
            walk(fullPath, depth + 1);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xer")) {
            const stats = statSync2(fullPath);
            found.push({ path: fullPath, sizeKb: Math.round(stats.size / 1024), modified: stats.mtime.toISOString() });
          }
        }
      };
      walk(root, 0);
      return { folder: root, files: found.sort((left, right) => right.modified.localeCompare(left.modified)) };
    },
    xer_open(args) {
      const xer = loadXer(pathOf(args.file));
      return {
        file: xer.path,
        p6Version: xer.version,
        exportDate: xer.exportDate,
        exportedBy: xer.exportUser,
        projects: listProjects(xer),
        tables: Object.fromEntries([...xer.tables].map(([name, rows]) => [name, rows.length]))
      };
    },
    xer_project_summary: (args) => summary(scheduleOf(args), args.criticalFloat),
    xer_list_activities(args) {
      const schedule = scheduleOf(args);
      return { project: schedule.projectCode, dataDate: schedule.dataDate, ...page(filterActivities(schedule, args).map(brief), args.limit, args.offset) };
    },
    xer_get_activity: (args) => detail(findActivity(scheduleOf(args), args.activityId)),
    xer_wbs: (args) => wbsTree(scheduleOf(args), args.maxDepth),
    xer_critical_path: (args) => criticalPath(scheduleOf(args), args.floatThreshold, args.includeCompleted),
    xer_driving_path(args) {
      const schedule = scheduleOf(args);
      let target = args.activityId ? findActivity(schedule, args.activityId) : void 0;
      if (!target) {
        target = latestFinish(schedule.activities.filter((activity) => activity.status !== "Completed"));
        if (!target)
          throw new XerError("The project has no incomplete activities.");
      }
      return drivingPath(schedule, target);
    },
    xer_schedule_health(args) {
      const schedule = scheduleOf(args);
      const baseline = args.baselineFile ? scheduleOf({ file: args.baselineFile, project: args.baselineProject ?? args.project }) : void 0;
      return dcmaCheck(schedule, baseline);
    },
    xer_compare(args) {
      const previous = scheduleOf({ file: args.previousFile, project: args.previousProject ?? args.project });
      const current = scheduleOf({ file: args.currentFile, project: args.project });
      return compareSchedules(previous, current, args.limit);
    },
    xer_lookahead: (args) => lookahead(scheduleOf(args), args.days, args.from),
    xer_resources: (args) => resourceSummary(scheduleOf(args)),
    xer_query_table(args) {
      const xer = loadXer(pathOf(args.file));
      if (!xer.tables.has(args.table))
        throw new XerError(`No table ${args.table}. Tables: ${[...xer.tables.keys()].join(", ")}`);
      const needle = args.contains?.toLowerCase();
      const rows = table(xer, args.table).filter((row) => Object.entries(args.where ?? {}).every(([field, value]) => row[field] === value) && (!needle || Object.values(row).some((value) => value.toLowerCase().includes(needle))));
      const fields = args.fields;
      const shaped = fields ? rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))) : rows;
      return { table: args.table, fields: fields ?? Object.keys(rows[0] ?? {}), ...page(shaped, args.limit, args.offset) };
    }
  };
}

// build/skill/spec.js
var ArgumentError = class extends Error {
};
function checkValue(arg, value) {
  const fail = (expected) => {
    throw new ArgumentError(`"${arg.name}" must be ${expected} (got ${JSON.stringify(value)}).`);
  };
  switch (arg.type) {
    case "string":
      if (typeof value !== "string")
        fail("text");
      if (arg.enum && !arg.enum.includes(value))
        fail(`one of ${arg.enum.join(", ")}`);
      return value;
    case "number":
    case "integer": {
      const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isFinite(number))
        fail("a number");
      const checked = number;
      if (arg.type === "integer" && !Number.isInteger(checked))
        fail("a whole number");
      if (arg.minimum !== void 0 && checked < arg.minimum)
        fail(`at least ${arg.minimum}`);
      if (arg.maximum !== void 0 && checked > arg.maximum)
        fail(`at most ${arg.maximum}`);
      return checked;
    }
    case "boolean":
      if (value === "true")
        return true;
      if (value === "false")
        return false;
      if (typeof value !== "boolean")
        fail("true or false");
      return value;
    case "array": {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (typeof item !== "string")
          fail("a list of text values");
        if (arg.items?.enum && !arg.items.enum.includes(item))
          fail(`a list of: ${arg.items.enum.join(", ")}`);
      }
      return list;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("an object");
      for (const entry of Object.values(value))
        if (typeof entry !== "string")
          fail("an object of text values");
      return value;
    }
  }
}
function checkArgs(tool, input) {
  const known = new Set(tool.args.map((arg) => arg.name));
  const unknown = Object.keys(input).filter((name) => !known.has(name));
  if (unknown.length)
    throw new ArgumentError(`Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`);
  const result = {};
  for (const arg of tool.args) {
    const value = input[arg.name];
    if (value === void 0) {
      if (arg.default !== void 0)
        result[arg.name] = arg.default;
      else if (arg.required)
        throw new ArgumentError(`Missing required argument "${arg.name}".`);
      continue;
    }
    result[arg.name] = checkValue(arg, value);
  }
  return result;
}

// build/skill/p6.js
var specs = JSON.parse(readFileSync2(fileURLToPath(new URL("./tools.json", import.meta.url)), "utf8"));
var handlers = createXerHandlers(() => process.cwd());
function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
function exitWith(message, code = 1) {
  process.stderr.write(message + "\n");
  process.exit(code);
}
function parseFlags(words) {
  const args = {};
  for (let index = 0; index < words.length; index++) {
    const match = words[index].match(/^--([A-Za-z]\w*)(?:=(.*))?$/s);
    if (!match)
      exitWith(`Unexpected argument "${words[index]}". Use --name value, or one JSON object.`);
    const [, name, inlineValue] = match;
    const next = words[index + 1];
    let value = inlineValue ?? (next !== void 0 && !next.startsWith("--") ? words[++index] : "true");
    if (typeof value === "string" && /^[[{]/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
      }
    }
    args[name] = name in args ? [].concat(args[name], value) : value;
  }
  return args;
}
function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    exitWith("Usage: p6.mjs list | p6.mjs help <tool> | p6.mjs <tool> --name value ... | p6.mjs <tool> '<json>'", command ? 0 : 2);
  }
  if (command === "list") {
    return print(specs.map((tool2) => ({ name: tool2.name, description: tool2.description })));
  }
  if (command === "help") {
    const tool2 = specs.find((spec) => spec.name === rest[0]);
    if (!tool2)
      exitWith(`Unknown tool "${rest[0] ?? ""}". Run "p6.mjs list".`);
    return print(tool2);
  }
  const tool = specs.find((spec) => spec.name === command);
  const handler = handlers[command];
  if (!tool || !handler)
    exitWith(`Unknown tool "${command}". Run "p6.mjs list".`);
  let input;
  if (rest.length === 1 && rest[0].trim().startsWith("{")) {
    try {
      input = JSON.parse(rest[0]);
    } catch (error) {
      exitWith(`Arguments are not valid JSON: ${error.message}`);
    }
  } else {
    input = parseFlags(rest);
  }
  try {
    print(handler(checkArgs(tool, input)));
  } catch (error) {
    const prefix = error instanceof ArgumentError ? `Invalid arguments for ${tool.name}: ` : "";
    exitWith(prefix + error.message + (prefix ? `
Run "p6.mjs help ${tool.name}" to see its arguments.` : ""));
  }
}
main();
