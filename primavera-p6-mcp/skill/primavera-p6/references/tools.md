# Tool reference

Generated from the tool schemas by `p6.mjs docs`. Run `node scripts/p6.mjs help <tool>` for the JSON schema of one tool.

## XER files (no P6 server needed)

### `xer_list_files`

Find .xer files in a folder (default P6_XER_DIR, else the current directory), newest first.

| Argument | Type | Notes |
| --- | --- | --- |
| `folder` | string | Folder to search; defaults to P6_XER_DIR |
| `recursive` | boolean | default `false` |

### `xer_open`

Load an XER file and list the projects and tables in it. Call this first to see what an XER contains; the other xer_* tools load the file on demand too.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |

### `xer_project_summary`

Key facts about a project in an XER: data date, start and finish, must-finish-by, activity counts by status and type, percent complete, critical and negative-float counts, cost totals.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `criticalFloat` | number | Total float (days) at or below which an activity counts as critical. default `0` |

### `xer_list_activities`

Activities in the project, ordered by start, with optional filters. Durations and floats are working days; dates are P6 dates (actual where they exist, otherwise forecast).

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `status` | "Not Started" \| "In Progress" \| "Completed"[] |  |
| `types` | string[] | Activity types, e.g. 'Task Dependent', 'Milestone', 'Level of Effort' (substring match) |
| `wbs` | string | WBS code prefix (e.g. '1.2') or part of a WBS name |
| `search` | string | Substring of activity ID or name |
| `maxFloat` | number | Only activities with total float <= this many days |
| `minFloat` | number | Only activities with total float >= this many days |
| `longestPathOnly` | boolean | Only activities P6 flagged as on the longest path |
| `startsAfter` | string | YYYY-MM-DD |
| `finishesBefore` | string | YYYY-MM-DD |
| `hasConstraint` | boolean |  |
| `resource` | string | Resource ID or name assigned to the activity |
| `limit` | integer | default `200` |
| `offset` | integer | default `0` |

### `xer_get_activity`

Everything about one activity: dates, durations, floats, constraint, calendar, WBS path, predecessors, successors and resource assignments.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `activityId` | string | **required**. Activity ID as shown in P6, e.g. A1010 |

### `xer_wbs`

The project's WBS as a tree, with activity count, start, finish and lowest total float under each element.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `maxDepth` | integer | default `10` |

### `xer_critical_path`

Incomplete activities with total float at or below a threshold (default 0) or on P6's longest path, in start order.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `floatThreshold` | number | Days of total float that still count as critical. default `0` |
| `includeCompleted` | boolean | default `false` |

### `xer_driving_path`

Trace the chain of driving predecessors back from an activity (default: the one that finishes last) to the data date. Use it to explain why a milestone finishes when it does.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `activityId` | string | Target activity ID; defaults to the latest-finishing incomplete activity |

### `xer_schedule_health`

Run the DCMA 14-point assessment: logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI and BEI. Each check lists offending activities. Pass a baseline XER for checks 11 and 14; otherwise planned dates are used.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `baselineFile` | string | XER of the baseline schedule, matched by activity ID |
| `baselineProject` | string |  |

### `xer_compare`

Compare two XERs of the same project (e.g. last month's update and this month's): finish slip, data date move, activities added and removed, changed durations, dates, float, status and constraints, and logic added, removed or with changed lag. Matching is by activity ID.

| Argument | Type | Notes |
| --- | --- | --- |
| `previousFile` | string | **required**. Earlier XER (baseline or previous update) |
| `currentFile` | string | **required**. Later XER |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `previousProject` | string | Project ID in the earlier file if it differs |
| `limit` | integer | Maximum items per list. default `100` |

### `xer_lookahead`

Incomplete activities that are in progress, start or finish within the next N days from the data date (or a given date). Good for 2-, 3- or 6-week look-aheads.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `days` | integer | default `21` |
| `from` | string | YYYY-MM-DD; defaults to the data date |

### `xer_resources`

Resources assigned in the project with planned, actual and remaining units and costs.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `project` | string | Project ID (short name) when the XER holds more than one project |

### `xer_query_table`

Read rows from any table in the XER (e.g. TASK, TASKPRED, PROJWBS, CALENDAR, RSRC, TASKRSRC, ACTVCODE, TASKACTV, UDFVALUE) with field names as P6 exports them. Use it for data the other tools don't cover.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to P6_XER_DIR) |
| `table` | string | **required**. Table name, e.g. TASK |
| `where` | object | Exact-match filters, e.g. { "proj_id": "4512" } |
| `contains` | string | Keep rows where any field contains this text (case-insensitive) |
| `fields` | string[] | Fields to return; default all |
| `limit` | integer | default `200` |
| `offset` | integer | default `0` |

## Live P6, read (needs P6_BASE_URL)

### `p6_connection_info`

Check the connection to the P6 server: logs in, reads one project, and reports the base URL, auth mode and whether write tools are enabled.

No arguments.

### `p6_list_projects`

Projects you can see in P6 with ID, name, status, EPS, data date, start and finish.

| Argument | Type | Notes |
| --- | --- | --- |
| `search` | string | Substring of project ID or name |
| `status` | "Active" \| "Inactive" \| "Planned" \| "What-If" \| "Requested" \| "Template" |  |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `orderBy` | string | e.g. 'StartDate asc' |
| `limit` | integer | default `500` |

### `p6_list_eps`

The Enterprise Project Structure (EPS) nodes, with parent links.

| Argument | Type | Notes |
| --- | --- | --- |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `limit` | integer | default `500` |

### `p6_list_wbs`

WBS elements of a project.

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `limit` | integer | default `500` |

### `p6_list_activities`

Activities of a project from P6. Durations and floats come back in hours, as the P6 API reports them. Filter with P6 filter syntax, e.g. "TotalFloat :lte: 0" or "Status :eq: 'In Progress'".

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `status` | "Not Started" \| "In Progress" \| "Completed" |  |
| `criticalOnly` | boolean |  |
| `wbsObjectId` | integer |  |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `orderBy` | string | e.g. 'StartDate asc' |
| `limit` | integer | default `500` |

### `p6_get_activity`

One activity with its predecessors, successors and resource assignments. Identify it by ObjectId, or by activity ID plus project.

| Argument | Type | Notes |
| --- | --- | --- |
| `activityObjectId` | integer |  |
| `activityId` | string | Activity ID as shown in P6, e.g. A1010 |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `fields` | string[] | P6 field names to return; defaults to a useful set |

### `p6_list_relationships`

Logic links of a project (or of one activity), with type, lag (hours) and whether the link is driving.

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `activityObjectId` | integer |  |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `limit` | integer | default `500` |

### `p6_list_resources`

Resources in the P6 resource dictionary.

| Argument | Type | Notes |
| --- | --- | --- |
| `search` | string |  |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `orderBy` | string | e.g. 'StartDate asc' |
| `limit` | integer | default `500` |

### `p6_list_resource_assignments`

Resource assignments of a project or activity with planned, actual and remaining units and costs.

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `activityObjectId` | integer |  |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `limit` | integer | default `500` |

### `p6_list_calendars`

Global, resource and project calendars with hours per day and week.

| Argument | Type | Notes |
| --- | --- | --- |
| `fields` | string[] | P6 field names to return; defaults to a useful set |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `limit` | integer | default `500` |

### `p6_read`

Generic read of any P6 REST business object (e.g. activityCode, activityCodeAssignment, udfValue, baselineProject, activityNote, projectIssue, risk). Fields are required by P6; use the object's field names from the P6 REST API documentation.

| Argument | Type | Notes |
| --- | --- | --- |
| `entity` | string | **required**. Endpoint name, e.g. activityCode |
| `fields` | string[] | **required** |
| `filter` | string | P6 REST filter, e.g. "Status :eq: 'In Progress' :and: TotalFloat :lt: 0". Operators :eq: :gt: :lt: :gte: :lte: :like: IN(...), joined with :and: / :or:. It is combined with the tool's own filters using :and:. |
| `orderBy` | string | e.g. 'StartDate asc' |
| `limit` | integer | default `500` |

### `p6_job_status`

Status of an asynchronous P6 job (schedule, level, summarize, export) by its JobId.

| Argument | Type | Notes |
| --- | --- | --- |
| `jobId` | string | **required** |

### `p6_export_xer`

Export one or more P6 projects to an XER file on this machine, so the xer_* analysis tools can use it.

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `projectObjectIds` | integer[] | Several projects into one file |
| `outFile` | string | **required**. Where to save the .xer (absolute, or relative to P6_XER_DIR) |

## Live P6, write (needs P6_BASE_URL and P6_ALLOW_WRITES=1)

### `p6_update_activities`

Update fields of one or more activities. Each object needs ObjectId plus the fields to change, e.g. { ObjectId: 123, Name: 'Pour slab', PlannedDuration: 40, PrimaryConstraintType: 'Start On or After', PrimaryConstraintDate: '2026-03-02T08:00:00' }. Durations are hours. For progress use ActualStartDate, ActualFinishDate, RemainingDuration, PhysicalPercentComplete. Reschedule afterwards with p6_schedule_project.

| Argument | Type | Notes |
| --- | --- | --- |
| `activities` | object[] | **required** |

### `p6_create_activities`

Create activities. Each needs ProjectObjectId, Id and Name, and usually WBSObjectId, PlannedDuration (hours) and Type ('Task Dependent', 'Start Milestone', 'Finish Milestone', ...). Returns the new ObjectIds.

| Argument | Type | Notes |
| --- | --- | --- |
| `activities` | object[] | **required** |

### `p6_delete_activities`

Delete activities by ObjectId. This also removes their relationships and assignments, and can't be undone from here.

| Argument | Type | Notes |
| --- | --- | --- |
| `objectIds` | integer[] | **required** |

### `p6_create_relationships`

Add logic links. Each needs PredecessorActivityObjectId, SuccessorActivityObjectId, Type ('Finish to Start', 'Start to Start', 'Finish to Finish', 'Start to Finish') and optional Lag in hours.

| Argument | Type | Notes |
| --- | --- | --- |
| `relationships` | object[] | **required** |

### `p6_update_relationships`

Change type or lag of relationships. Each object needs ObjectId plus fields to change, e.g. { ObjectId: 77, Lag: 16 }.

| Argument | Type | Notes |
| --- | --- | --- |
| `relationships` | object[] | **required** |

### `p6_delete_relationships`

Delete relationships by ObjectId.

| Argument | Type | Notes |
| --- | --- | --- |
| `objectIds` | integer[] | **required** |

### `p6_create_resource_assignments`

Assign resources to activities. Each needs ActivityObjectId and ResourceObjectId (or RoleObjectId), and optionally PlannedUnits.

| Argument | Type | Notes |
| --- | --- | --- |
| `assignments` | object[] | **required** |

### `p6_schedule_project`

Run the P6 scheduler on a project, optionally moving the data date, and wait for it to finish (up to waitSeconds). Same as F9 in P6.

| Argument | Type | Notes |
| --- | --- | --- |
| `projectObjectId` | integer | Project ObjectId |
| `projectId` | string | Project ID (short code) if you don't know the ObjectId |
| `newDataDate` | string | ISO date-time, e.g. 2026-11-30T08:00:00 |
| `waitSeconds` | integer | default `120` |
