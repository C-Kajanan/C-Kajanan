// Tools that talk to a live P6 EPPM server through its REST API.
// Read tools are always available once P6_BASE_URL is set; tools that change
// data are registered only when P6_ALLOW_WRITES=1.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { P6Client, P6Error } from "../p6Client.js";
import { page, type ToolDef } from "./types.js";

let client: P6Client | undefined | null = null;
export function p6(): P6Client {
  if (client === null) client = P6Client.fromEnv();
  if (!client) {
    throw new P6Error(
      "No P6 server is configured. Set P6_BASE_URL (e.g. https://p6.example.com/p6ws/restapi) plus P6_USERNAME, P6_PASSWORD and P6_DATABASE, or P6_AUTH_TOKEN. The xer_* tools work without a server.",
    );
  }
  return client;
}
/** For tests. */
export function resetP6Client() {
  client = null;
}

export const writesEnabled = () => /^(1|true|yes)$/i.test(process.env.P6_ALLOW_WRITES ?? "");

const FIELDS = {
  project: ["ObjectId", "Id", "Name", "Status", "ParentEPSName", "DataDate", "PlannedStartDate", "StartDate", "FinishDate", "ScheduledFinishDate", "MustFinishByDate", "LastScheduleDate"],
  eps: ["ObjectId", "Id", "Name", "ParentObjectId", "ParentEPSName"],
  wbs: ["ObjectId", "Code", "Name", "ParentObjectId", "ProjectObjectId", "SequenceNumber", "StartDate", "FinishDate", "Status"],
  activity: [
    "ObjectId", "Id", "Name", "Status", "Type", "WBSCode", "WBSName", "PlannedDuration", "RemainingDuration", "ActualDuration",
    "StartDate", "FinishDate", "ActualStartDate", "ActualFinishDate", "EarlyStartDate", "EarlyFinishDate", "LateStartDate", "LateFinishDate",
    "PlannedStartDate", "PlannedFinishDate", "BaselineStartDate", "BaselineFinishDate", "TotalFloat", "FreeFloat", "PercentComplete",
    "PhysicalPercentComplete", "PrimaryConstraintType", "PrimaryConstraintDate", "IsCritical", "IsLongestPath", "CalendarName", "PrimaryResourceName",
  ],
  relationship: ["ObjectId", "PredecessorActivityId", "PredecessorActivityName", "PredecessorActivityObjectId", "SuccessorActivityId", "SuccessorActivityName", "SuccessorActivityObjectId", "Type", "Lag", "Driving"],
  resource: ["ObjectId", "Id", "Name", "ResourceType", "IsActive", "MaxUnitsPerTime", "PrimaryRoleName", "CalendarName", "UnitOfMeasureAbbreviation"],
  resourceAssignment: [
    "ObjectId", "ActivityId", "ActivityName", "ActivityObjectId", "ResourceId", "ResourceName", "ResourceType", "RoleName",
    "PlannedUnits", "ActualUnits", "RemainingUnits", "PlannedCost", "ActualCost", "RemainingCost", "StartDate", "FinishDate",
  ],
  calendar: ["ObjectId", "Name", "Type", "IsDefault", "HoursPerDay", "HoursPerWeek", "ProjectObjectId"],
};

const limit = z.number().int().min(1).max(10000).default(500);
const fields = z.array(z.string()).optional().describe("P6 field names to return; defaults to a useful set");
const filter = z
  .string()
  .optional()
  .describe(
    "P6 REST filter, e.g. \"Status :eq: 'In Progress' :and: TotalFloat :lt: 0\". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:.",
  );
const orderBy = z.string().optional().describe("e.g. 'StartDate asc'");
const projectRef = {
  projectObjectId: z.number().int().optional().describe("Project ObjectId"),
  projectId: z.string().optional().describe("Project ID (short code) if you don't know the ObjectId"),
};

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const and = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" :and: ") || undefined;
const matches = (search: string | undefined) => (row: Record<string, unknown>) =>
  !search || [row.Id, row.Name].some((v) => String(v ?? "").toLowerCase().includes(search.toLowerCase()));

async function projectObjectId(args: { projectObjectId?: number; projectId?: string }, required = true): Promise<number | undefined> {
  if (args.projectObjectId) return args.projectObjectId;
  if (!args.projectId) {
    if (required) throw new P6Error("Pass projectObjectId or projectId. Use p6_list_projects to find them.");
    return undefined;
  }
  const rows = await p6().read<{ ObjectId: number; Id: string }>("project", ["ObjectId", "Id"], `Id :eq: ${quote(args.projectId)}`);
  if (!rows.length) throw new P6Error(`No project with ID "${args.projectId}".`);
  return rows[0].ObjectId;
}

async function activityObjectId(args: { activityObjectId?: number; activityId?: string; projectObjectId?: number; projectId?: string }) {
  if (args.activityObjectId) return args.activityObjectId;
  if (!args.activityId) throw new P6Error("Pass activityObjectId, or activityId with projectObjectId/projectId.");
  const proj = await projectObjectId(args);
  const rows = await p6().read<{ ObjectId: number }>("activity", ["ObjectId"], and(`Id :eq: ${quote(args.activityId)}`, `ProjectObjectId :eq: ${proj}`));
  if (!rows.length) throw new P6Error(`No activity "${args.activityId}" in project ${proj}.`);
  return rows[0].ObjectId;
}

const fieldsFor = (entity: string, requested?: string[], must: string[] = []) => {
  const base = requested?.length ? requested : ((FIELDS as Record<string, string[]>)[entity] ?? ["ObjectId"]);
  return [...new Set([...base, ...must])];
};

const readList = async (
  entity: string,
  a: { fields?: string[]; filter?: string; orderBy?: string; limit: number; search?: string },
  extraFilter?: string,
) => {
  const rows = await p6().read(entity, fieldsFor(entity, a.fields, a.search ? ["Id", "Name"] : []), and(extraFilter, a.filter), a.orderBy);
  return page(rows.filter(matches(a.search)), a.limit);
};

async function waitForJob(jobId: string, timeoutS: number) {
  const deadline = Date.now() + timeoutS * 1000;
  let status: unknown;
  do {
    status = await p6().request("GET", "/job/readJobStatus", { query: { JobId: jobId } });
    const text = JSON.stringify(status);
    if (/complete|fail|cancel|error/i.test(text)) break;
    await new Promise((r) => setTimeout(r, 2000));
  } while (Date.now() < deadline);
  return status;
}

export const p6ReadTools: ToolDef[] = [
  {
    name: "p6_connection_info",
    title: "P6 connection info",
    description: "Check the connection to the P6 server: logs in, reads one project, and reports the base URL, auth mode and whether write tools are enabled.",
    input: {},
    readOnly: true,
    openWorld: true,
    async run() {
      const c = p6();
      const sample = await c.read("project", ["ObjectId", "Id"]);
      return { baseUrl: c.options.baseUrl, database: c.options.database, authMode: c.authMode, connected: true, visibleProjects: sample.length, writesEnabled: writesEnabled() };
    },
  },
  {
    name: "p6_list_projects",
    title: "List P6 projects",
    description: "Projects you can see in P6 with ID, name, status, EPS, data date, start and finish.",
    input: {
      search: z.string().optional().describe("Substring of project ID or name"),
      status: z.enum(["Active", "Inactive", "Planned", "What-If", "Requested", "Template"]).optional(),
      fields,
      filter,
      orderBy,
      limit,
    },
    readOnly: true,
    openWorld: true,
    run(a) {
      return readList("project", a, a.status ? `Status :eq: ${quote(a.status)}` : undefined);
    },
  },
  {
    name: "p6_list_eps",
    title: "List EPS",
    description: "The Enterprise Project Structure (EPS) nodes, with parent links.",
    input: { fields, filter, limit },
    readOnly: true,
    openWorld: true,
    run: (a) => readList("eps", a),
  },
  {
    name: "p6_list_wbs",
    title: "List WBS",
    description: "WBS elements of a project.",
    input: { ...projectRef, fields, filter, limit },
    readOnly: true,
    openWorld: true,
    async run(a) {
      return readList("wbs", { orderBy: "SequenceNumber asc", ...a }, `ProjectObjectId :eq: ${await projectObjectId(a)}`);
    },
  },
  {
    name: "p6_list_activities",
    title: "List activities",
    description:
      "Activities of a project from P6. Durations and floats come back in hours, as the P6 API reports them. Filter with P6 filter syntax, e.g. \"TotalFloat :lte: 0\" or \"Status :eq: 'In Progress'\".",
    input: {
      ...projectRef,
      status: z.enum(["Not Started", "In Progress", "Completed"]).optional(),
      criticalOnly: z.boolean().optional(),
      wbsObjectId: z.number().int().optional(),
      fields,
      filter,
      orderBy,
      limit,
    },
    readOnly: true,
    openWorld: true,
    async run(a) {
      const base = and(
        `ProjectObjectId :eq: ${await projectObjectId(a)}`,
        a.status ? `Status :eq: ${quote(a.status)}` : undefined,
        a.criticalOnly ? "IsCritical :eq: true" : undefined,
        a.wbsObjectId ? `WBSObjectId :eq: ${a.wbsObjectId}` : undefined,
      );
      return readList("activity", { orderBy: "StartDate asc", ...a }, base);
    },
  },
  {
    name: "p6_get_activity",
    title: "Get activity",
    description: "One activity with its predecessors, successors and resource assignments. Identify it by ObjectId, or by activity ID plus project.",
    input: {
      activityObjectId: z.number().int().optional(),
      activityId: z.string().optional().describe("Activity ID as shown in P6, e.g. A1010"),
      ...projectRef,
      fields,
    },
    readOnly: true,
    openWorld: true,
    async run(a) {
      const id = await activityObjectId(a);
      const c = p6();
      const [act] = await c.read("activity", a.fields?.length ? a.fields : FIELDS.activity, `ObjectId :eq: ${id}`);
      if (!act) throw new P6Error(`No activity with ObjectId ${id}.`);
      const [preds, succs, assignments] = await Promise.all([
        c.read("relationship", FIELDS.relationship, `SuccessorActivityObjectId :eq: ${id}`),
        c.read("relationship", FIELDS.relationship, `PredecessorActivityObjectId :eq: ${id}`),
        c.read("resourceAssignment", FIELDS.resourceAssignment, `ActivityObjectId :eq: ${id}`),
      ]);
      return { ...act, predecessors: preds, successors: succs, resourceAssignments: assignments };
    },
  },
  {
    name: "p6_list_relationships",
    title: "List relationships",
    description: "Logic links of a project (or of one activity), with type, lag (hours) and whether the link is driving.",
    input: { ...projectRef, activityObjectId: z.number().int().optional(), fields, filter, limit },
    readOnly: true,
    openWorld: true,
    async run(a) {
      // Two reads instead of one :or: filter, so a user filter can be added with :and: safely.
      const [predField, succField, id] = a.activityObjectId
        ? ["PredecessorActivityObjectId", "SuccessorActivityObjectId", a.activityObjectId]
        : ["PredecessorProjectObjectId", "SuccessorProjectObjectId", await projectObjectId(a)];
      const f = fieldsFor("relationship", a.fields, ["ObjectId"]);
      const [asPred, asSucc] = await Promise.all([
        p6().read("relationship", f, and(`${predField} :eq: ${id}`, a.filter)),
        p6().read("relationship", f, and(`${succField} :eq: ${id}`, a.filter)),
      ]);
      const merged = new Map([...asPred, ...asSucc].map((r) => [r.ObjectId, r]));
      return page([...merged.values()], a.limit);
    },
  },
  {
    name: "p6_list_resources",
    title: "List resources",
    description: "Resources in the P6 resource dictionary.",
    input: { search: z.string().optional(), fields, filter, orderBy, limit },
    readOnly: true,
    openWorld: true,
    run: (a) => readList("resource", a),
  },
  {
    name: "p6_list_resource_assignments",
    title: "List resource assignments",
    description: "Resource assignments of a project or activity with planned, actual and remaining units and costs.",
    input: { ...projectRef, activityObjectId: z.number().int().optional(), fields, filter, limit },
    readOnly: true,
    openWorld: true,
    async run(a) {
      const base = a.activityObjectId ? `ActivityObjectId :eq: ${a.activityObjectId}` : `ProjectObjectId :eq: ${await projectObjectId(a)}`;
      return readList("resourceAssignment", a, base);
    },
  },
  {
    name: "p6_list_calendars",
    title: "List calendars",
    description: "Global, resource and project calendars with hours per day and week.",
    input: { fields, filter, limit },
    readOnly: true,
    openWorld: true,
    run: (a) => readList("calendar", a),
  },
  {
    name: "p6_read",
    title: "Read any P6 object",
    description:
      "Generic read of any P6 REST business object (e.g. activityCode, activityCodeAssignment, udfValue, baselineProject, activityNote, projectIssue, risk). Fields are required by P6; use the object's field names from the P6 REST API documentation.",
    input: {
      entity: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Endpoint name, e.g. activityCode"),
      fields: z.array(z.string()).min(1),
      filter,
      orderBy,
      limit,
    },
    readOnly: true,
    openWorld: true,
    run: (a) => readList(a.entity, a),
  },
  {
    name: "p6_job_status",
    title: "Job status",
    description: "Status of an asynchronous P6 job (schedule, level, summarize, export) by its JobId.",
    input: { jobId: z.string() },
    readOnly: true,
    openWorld: true,
    run: (a) => p6().request("GET", "/job/readJobStatus", { query: { JobId: a.jobId } }),
  },
  {
    name: "p6_export_xer",
    title: "Export project to XER",
    description: "Export one or more P6 projects to an XER file on this machine, so the xer_* analysis tools can use it.",
    input: {
      ...projectRef,
      projectObjectIds: z.array(z.number().int()).optional().describe("Several projects into one file"),
      outFile: z.string().describe("Where to save the .xer (absolute, or relative to P6_XER_DIR)"),
    },
    // Writes a local file, so not read-only, but doesn't change P6.
    readOnly: false,
    openWorld: true,
    async run(a) {
      const ids: number[] = a.projectObjectIds?.length ? a.projectObjectIds : [(await projectObjectId(a))!];
      const res = await p6().request<Response>("POST", "/export/exportXERProject", { body: { ProjectObjectId: ids, FileType: "XER" }, raw: true });
      const bytes = Buffer.from(await res.arrayBuffer());
      const out = resolve(process.env.P6_XER_DIR || process.cwd(), a.outFile);
      writeFileSync(out, bytes);
      const looksXer = bytes.subarray(0, 6).toString("latin1") === "ERMHDR";
      return {
        file: out,
        bytes: bytes.length,
        contentType: res.headers.get("content-type"),
        note: looksXer ? "Saved. Open it with xer_open." : "Saved, but the file doesn't start with ERMHDR. It may be zipped or an error page; check the content type.",
      };
    },
  },
];

const objects = z.array(z.record(z.string(), z.unknown())).min(1).max(1000);

export const p6WriteTools: ToolDef[] = [
  {
    name: "p6_update_activities",
    title: "Update activities",
    description:
      "Update fields of one or more activities. Each object needs ObjectId plus the fields to change, e.g. { ObjectId: 123, Name: 'Pour slab', PlannedDuration: 40, PrimaryConstraintType: 'Start On or After', PrimaryConstraintDate: '2026-03-02T08:00:00' }. Durations are hours. For progress use ActualStartDate, ActualFinishDate, RemainingDuration, PhysicalPercentComplete. Reschedule afterwards with p6_schedule_project.",
    input: { activities: objects },
    openWorld: true,
    async run(a) {
      for (const o of a.activities) if (typeof o.ObjectId !== "number") throw new P6Error("Every activity needs a numeric ObjectId.");
      return { updated: a.activities.length, result: await p6().update("activity", a.activities) };
    },
  },
  {
    name: "p6_create_activities",
    title: "Create activities",
    description:
      "Create activities. Each needs ProjectObjectId, Id and Name, and usually WBSObjectId, PlannedDuration (hours) and Type ('Task Dependent', 'Start Milestone', 'Finish Milestone', ...). Returns the new ObjectIds.",
    input: { activities: objects },
    openWorld: true,
    async run(a) {
      return { created: await p6().create("activity", a.activities) };
    },
  },
  {
    name: "p6_delete_activities",
    title: "Delete activities",
    description: "Delete activities by ObjectId. This also removes their relationships and assignments, and can't be undone from here.",
    input: { objectIds: z.array(z.number().int()).min(1).max(500) },
    destructive: true,
    openWorld: true,
    async run(a) {
      return { deleted: a.objectIds, result: await p6().delete("activity", a.objectIds) };
    },
  },
  {
    name: "p6_create_relationships",
    title: "Create relationships",
    description:
      "Add logic links. Each needs PredecessorActivityObjectId, SuccessorActivityObjectId, Type ('Finish to Start', 'Start to Start', 'Finish to Finish', 'Start to Finish') and optional Lag in hours.",
    input: { relationships: objects },
    openWorld: true,
    async run(a) {
      return { created: await p6().create("relationship", a.relationships) };
    },
  },
  {
    name: "p6_update_relationships",
    title: "Update relationships",
    description: "Change type or lag of relationships. Each object needs ObjectId plus fields to change, e.g. { ObjectId: 77, Lag: 16 }.",
    input: { relationships: objects },
    openWorld: true,
    async run(a) {
      return { updated: a.relationships.length, result: await p6().update("relationship", a.relationships) };
    },
  },
  {
    name: "p6_delete_relationships",
    title: "Delete relationships",
    description: "Delete relationships by ObjectId.",
    input: { objectIds: z.array(z.number().int()).min(1).max(500) },
    destructive: true,
    openWorld: true,
    async run(a) {
      return { deleted: a.objectIds, result: await p6().delete("relationship", a.objectIds) };
    },
  },
  {
    name: "p6_create_resource_assignments",
    title: "Assign resources",
    description: "Assign resources to activities. Each needs ActivityObjectId and ResourceObjectId (or RoleObjectId), and optionally PlannedUnits.",
    input: { assignments: objects },
    openWorld: true,
    async run(a) {
      return { created: await p6().create("resourceAssignment", a.assignments) };
    },
  },
  {
    name: "p6_schedule_project",
    title: "Schedule project (F9)",
    description:
      "Run the P6 scheduler on a project, optionally moving the data date, and wait for it to finish (up to waitSeconds). Same as F9 in P6.",
    input: {
      ...projectRef,
      newDataDate: z.string().optional().describe("ISO date-time, e.g. 2026-11-30T08:00:00"),
      waitSeconds: z.number().int().min(0).max(600).default(120),
    },
    openWorld: true,
    async run(a) {
      const id = await projectObjectId(a);
      const body: Record<string, unknown> = { ProjectObjectId: [id], Timeout: Math.min(a.waitSeconds, 60) };
      if (a.newDataDate) body.NewDataDate = a.newDataDate;
      const job = await p6().request<{ JobId?: string; JobStatus?: string }>("POST", "/job/schedule", { body });
      const done = !job?.JobId || /complete|fail|cancel/i.test(job.JobStatus ?? "");
      const status = done || a.waitSeconds === 0 ? job : await waitForJob(job.JobId!, a.waitSeconds);
      return { projectObjectId: id, job, status };
    },
  },
];
