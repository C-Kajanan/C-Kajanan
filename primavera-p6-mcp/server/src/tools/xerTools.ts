// Tools that work on XER files exported from P6. They need no connection to
// a P6 server, only read access to the file.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  compareSchedules,
  criticalPath,
  dcmaCheck,
  drivingPath,
  filterActivities,
  latestFinish,
  lookahead,
  resourceSummary,
  summary,
  wbsTree,
} from "../analysis.js";
import { brief, buildSchedule, detail, findActivity, listProjects } from "../schedule.js";
import { loadXer, table, XerError } from "../xer.js";
import { page, type ToolDef } from "./types.js";

const file = z.string().describe("Path to the .xer file (absolute, or relative to P6_XER_DIR)");
const project = z.string().optional().describe("Project ID (short name) when the XER holds more than one project");
const limit = z.number().int().min(1).max(5000).default(200);
const offset = z.number().int().min(0).default(0);

const xerDir = () => process.env.P6_XER_DIR || process.cwd();
const pathOf = (p: string) => resolve(xerDir(), p);
const sched = (args: { file: string; project?: string }) => buildSchedule(loadXer(pathOf(args.file)), args.project);

export const xerTools: ToolDef[] = [
  {
    name: "xer_list_files",
    title: "List XER files",
    description: "Find .xer files in a folder (default P6_XER_DIR or the server's working directory), newest first.",
    input: {
      folder: z.string().optional().describe("Folder to search; defaults to P6_XER_DIR"),
      recursive: z.boolean().default(false),
    },
    readOnly: true,
    run({ folder, recursive }) {
      const root = resolve(xerDir(), folder ?? ".");
      const found: { path: string; sizeKb: number; modified: string }[] = [];
      const walk = (dir: string, depth: number) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          throw new XerError(`Can't read folder ${dir}`);
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory() && recursive && depth < 6 && !e.name.startsWith(".")) walk(p, depth + 1);
          else if (e.isFile() && e.name.toLowerCase().endsWith(".xer")) {
            const st = statSync(p);
            found.push({ path: p, sizeKb: Math.round(st.size / 1024), modified: st.mtime.toISOString() });
          }
        }
      };
      walk(root, 0);
      return { folder: root, files: found.sort((a, b) => b.modified.localeCompare(a.modified)) };
    },
  },
  {
    name: "xer_open",
    title: "Open XER file",
    description:
      "Load an XER file and list the projects and tables in it. Call this first to see what an XER contains; the other xer_* tools load the file on demand too.",
    input: { file },
    readOnly: true,
    run({ file }) {
      const xer = loadXer(pathOf(file));
      return {
        file: xer.path,
        p6Version: xer.version,
        exportDate: xer.exportDate,
        exportedBy: xer.exportUser,
        projects: listProjects(xer),
        tables: Object.fromEntries([...xer.tables].map(([k, v]) => [k, v.length])),
      };
    },
  },
  {
    name: "xer_project_summary",
    title: "Project summary",
    description:
      "Key facts about a project in an XER: data date, start and finish, must-finish-by, activity counts by status and type, percent complete, critical and negative-float counts, cost totals.",
    input: { file, project, criticalFloat: z.number().default(0).describe("Total float (days) at or below which an activity counts as critical") },
    readOnly: true,
    run: (a) => summary(sched(a), a.criticalFloat),
  },
  {
    name: "xer_list_activities",
    title: "List activities",
    description:
      "Activities in the project, ordered by start, with optional filters. Durations and floats are working days; dates are P6 dates (actual where they exist, otherwise forecast).",
    input: {
      file,
      project,
      status: z.array(z.enum(["Not Started", "In Progress", "Completed"])).optional(),
      types: z.array(z.string()).optional().describe("Activity types, e.g. 'Task Dependent', 'Milestone', 'Level of Effort' (substring match)"),
      wbs: z.string().optional().describe("WBS code prefix (e.g. '1.2') or part of a WBS name"),
      search: z.string().optional().describe("Substring of activity ID or name"),
      maxFloat: z.number().optional().describe("Only activities with total float <= this many days"),
      minFloat: z.number().optional().describe("Only activities with total float >= this many days"),
      longestPathOnly: z.boolean().optional().describe("Only activities P6 flagged as on the longest path"),
      startsAfter: z.string().optional().describe("YYYY-MM-DD"),
      finishesBefore: z.string().optional().describe("YYYY-MM-DD"),
      hasConstraint: z.boolean().optional(),
      resource: z.string().optional().describe("Resource ID or name assigned to the activity"),
      limit,
      offset,
    },
    readOnly: true,
    run(a) {
      const s = sched(a);
      return { project: s.projectCode, dataDate: s.dataDate, ...page(filterActivities(s, a).map(brief), a.limit, a.offset) };
    },
  },
  {
    name: "xer_get_activity",
    title: "Get activity",
    description: "Everything about one activity: dates, durations, floats, constraint, calendar, WBS path, predecessors, successors and resource assignments.",
    input: { file, project, activityId: z.string().describe("Activity ID as shown in P6, e.g. A1010") },
    readOnly: true,
    run: (a) => detail(findActivity(sched(a), a.activityId)),
  },
  {
    name: "xer_wbs",
    title: "WBS tree",
    description: "The project's WBS as a tree, with activity count, start, finish and lowest total float under each element.",
    input: { file, project, maxDepth: z.number().int().min(0).max(20).default(10) },
    readOnly: true,
    run: (a) => wbsTree(sched(a), a.maxDepth),
  },
  {
    name: "xer_critical_path",
    title: "Critical path",
    description: "Incomplete activities with total float at or below a threshold (default 0) or on P6's longest path, in start order.",
    input: {
      file,
      project,
      floatThreshold: z.number().default(0).describe("Days of total float that still count as critical"),
      includeCompleted: z.boolean().default(false),
    },
    readOnly: true,
    run: (a) => criticalPath(sched(a), a.floatThreshold, a.includeCompleted),
  },
  {
    name: "xer_driving_path",
    title: "Driving path to an activity",
    description:
      "Trace the chain of driving predecessors back from an activity (default: the one that finishes last) to the data date. Use it to explain why a milestone finishes when it does.",
    input: { file, project, activityId: z.string().optional().describe("Target activity ID; defaults to the latest-finishing incomplete activity") },
    readOnly: true,
    run(a) {
      const s = sched(a);
      let target = a.activityId ? findActivity(s, a.activityId) : undefined;
      if (!target) {
        target = latestFinish(s.activities.filter((x) => x.status !== "Completed"));
        if (!target) throw new XerError("The project has no incomplete activities.");
      }
      return drivingPath(s, target);
    },
  },
  {
    name: "xer_schedule_health",
    title: "Schedule health check (DCMA 14-point)",
    description:
      "Run the DCMA 14-point assessment: logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI and BEI. Each check lists offending activities. Pass a baseline XER for checks 11 and 14; otherwise planned dates are used.",
    input: {
      file,
      project,
      baselineFile: z.string().optional().describe("XER of the baseline schedule, matched by activity ID"),
      baselineProject: z.string().optional(),
    },
    readOnly: true,
    run(a) {
      const s = sched(a);
      const b = a.baselineFile ? sched({ file: a.baselineFile, project: a.baselineProject ?? a.project }) : undefined;
      return dcmaCheck(s, b);
    },
  },
  {
    name: "xer_compare",
    title: "Compare two schedules",
    description:
      "Compare two XERs of the same project (e.g. last month's update and this month's): finish slip, data date move, activities added and removed, changed durations, dates, float, status and constraints, and logic added, removed or with changed lag. Matching is by activity ID.",
    input: {
      previousFile: z.string().describe("Earlier XER (baseline or previous update)"),
      currentFile: z.string().describe("Later XER"),
      project,
      previousProject: z.string().optional().describe("Project ID in the earlier file if it differs"),
      limit: z.number().int().min(1).max(5000).default(100).describe("Maximum items per list"),
    },
    readOnly: true,
    run(a) {
      const prev = sched({ file: a.previousFile, project: a.previousProject ?? a.project });
      const curr = sched({ file: a.currentFile, project: a.project });
      return compareSchedules(prev, curr, a.limit);
    },
  },
  {
    name: "xer_lookahead",
    title: "Look-ahead",
    description: "Incomplete activities that are in progress, start or finish within the next N days from the data date (or a given date). Good for 2-, 3- or 6-week look-aheads.",
    input: { file, project, days: z.number().int().min(1).max(366).default(21), from: z.string().optional().describe("YYYY-MM-DD; defaults to the data date") },
    readOnly: true,
    run: (a) => lookahead(sched(a), a.days, a.from),
  },
  {
    name: "xer_resources",
    title: "Resource loading",
    description: "Resources assigned in the project with planned, actual and remaining units and costs.",
    input: { file, project },
    readOnly: true,
    run: (a) => resourceSummary(sched(a)),
  },
  {
    name: "xer_query_table",
    title: "Query raw XER table",
    description:
      "Read rows from any table in the XER (e.g. TASK, TASKPRED, PROJWBS, CALENDAR, RSRC, TASKRSRC, ACTVCODE, TASKACTV, UDFVALUE) with field names as P6 exports them. Use it for data the other tools don't cover.",
    input: {
      file,
      table: z.string().describe("Table name, e.g. TASK"),
      where: z.record(z.string(), z.string()).optional().describe("Exact-match filters, e.g. { \"proj_id\": \"4512\" }"),
      contains: z.string().optional().describe("Keep rows where any field contains this text (case-insensitive)"),
      fields: z.array(z.string()).optional().describe("Fields to return; default all"),
      limit,
      offset,
    },
    readOnly: true,
    run(a) {
      const xer = loadXer(pathOf(a.file));
      if (!xer.tables.has(a.table)) throw new XerError(`No table ${a.table}. Tables: ${[...xer.tables.keys()].join(", ")}`);
      const needle = a.contains?.toLowerCase();
      const rows = table(xer, a.table).filter(
        (r) =>
          Object.entries((a.where ?? {}) as Record<string, string>).every(([k, v]) => r[k] === v) &&
          (!needle || Object.values(r).some((v) => v.toLowerCase().includes(needle))),
      );
      const fields = a.fields as string[] | undefined;
      const shaped = fields ? rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))) : rows;
      return { table: a.table, fields: fields ?? Object.keys(rows[0] ?? {}), ...page(shaped, a.limit, a.offset) };
    },
  },
];
