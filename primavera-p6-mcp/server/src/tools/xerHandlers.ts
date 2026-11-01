// What each xer_* tool does. This module only reads local files: it makes no
// network calls and reads no environment variables. The MCP server and the
// primavera-p6 skill both call these handlers; they differ only in how they
// validate arguments (zod in the server, a small checker in the skill).

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  type ActivityFilter,
} from "../analysis.js";
import { brief, buildSchedule, detail, findActivity, listProjects } from "../schedule.js";
import { loadXer, table, XerError } from "../xer.js";
import { page } from "./types.js";

interface FileArgs {
  file: string;
  project?: string;
}
interface PageArgs {
  limit: number;
  offset: number;
}

export type XerHandler = (args: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Handlers keyed by tool name. Relative paths resolve against baseDir(). */
export function createXerHandlers(baseDir: () => string): Record<string, XerHandler> {
  const pathOf = (path: string) => resolve(baseDir(), path);
  const scheduleOf = (args: FileArgs) => buildSchedule(loadXer(pathOf(args.file)), args.project);

  return {
    xer_list_files(args: { folder?: string; recursive: boolean }) {
      const root = resolve(baseDir(), args.folder ?? ".");
      const found: { path: string; sizeKb: number; modified: string }[] = [];
      const walk = (dir: string, depth: number) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          throw new XerError(`Can't read folder ${dir}`);
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory() && args.recursive && depth < 6 && !entry.name.startsWith(".")) walk(fullPath, depth + 1);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xer")) {
            const stats = statSync(fullPath);
            found.push({ path: fullPath, sizeKb: Math.round(stats.size / 1024), modified: stats.mtime.toISOString() });
          }
        }
      };
      walk(root, 0);
      return { folder: root, files: found.sort((left, right) => right.modified.localeCompare(left.modified)) };
    },

    xer_open(args: { file: string }) {
      const xer = loadXer(pathOf(args.file));
      return {
        file: xer.path,
        p6Version: xer.version,
        exportDate: xer.exportDate,
        exportedBy: xer.exportUser,
        projects: listProjects(xer),
        tables: Object.fromEntries([...xer.tables].map(([name, rows]) => [name, rows.length])),
      };
    },

    xer_project_summary: (args: FileArgs & { criticalFloat: number }) => summary(scheduleOf(args), args.criticalFloat),

    xer_list_activities(args: FileArgs & PageArgs & ActivityFilter) {
      const schedule = scheduleOf(args);
      return { project: schedule.projectCode, dataDate: schedule.dataDate, ...page(filterActivities(schedule, args).map(brief), args.limit, args.offset) };
    },

    xer_get_activity: (args: FileArgs & { activityId: string }) => detail(findActivity(scheduleOf(args), args.activityId)),

    xer_wbs: (args: FileArgs & { maxDepth: number }) => wbsTree(scheduleOf(args), args.maxDepth),

    xer_critical_path: (args: FileArgs & { floatThreshold: number; includeCompleted: boolean }) =>
      criticalPath(scheduleOf(args), args.floatThreshold, args.includeCompleted),

    xer_driving_path(args: FileArgs & { activityId?: string }) {
      const schedule = scheduleOf(args);
      let target = args.activityId ? findActivity(schedule, args.activityId) : undefined;
      if (!target) {
        target = latestFinish(schedule.activities.filter((activity) => activity.status !== "Completed"));
        if (!target) throw new XerError("The project has no incomplete activities.");
      }
      return drivingPath(schedule, target);
    },

    xer_schedule_health(args: FileArgs & { baselineFile?: string; baselineProject?: string }) {
      const schedule = scheduleOf(args);
      const baseline = args.baselineFile ? scheduleOf({ file: args.baselineFile, project: args.baselineProject ?? args.project }) : undefined;
      return dcmaCheck(schedule, baseline);
    },

    xer_compare(args: { previousFile: string; currentFile: string; project?: string; previousProject?: string; limit: number }) {
      const previous = scheduleOf({ file: args.previousFile, project: args.previousProject ?? args.project });
      const current = scheduleOf({ file: args.currentFile, project: args.project });
      return compareSchedules(previous, current, args.limit);
    },

    xer_lookahead: (args: FileArgs & { days: number; from?: string }) => lookahead(scheduleOf(args), args.days, args.from),

    xer_resources: (args: FileArgs) => resourceSummary(scheduleOf(args)),

    xer_query_table(args: PageArgs & { file: string; table: string; where?: Record<string, string>; contains?: string; fields?: string[] }) {
      const xer = loadXer(pathOf(args.file));
      if (!xer.tables.has(args.table)) throw new XerError(`No table ${args.table}. Tables: ${[...xer.tables.keys()].join(", ")}`);
      const needle = args.contains?.toLowerCase();
      const rows = table(xer, args.table).filter(
        (row) =>
          Object.entries(args.where ?? {}).every(([field, value]) => row[field] === value) &&
          (!needle || Object.values(row).some((value) => value.toLowerCase().includes(needle))),
      );
      const fields = args.fields;
      const shaped = fields ? rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))) : rows;
      return { table: args.table, fields: fields ?? Object.keys(rows[0] ?? {}), ...page(shaped, args.limit, args.offset) };
    },
  };
}
