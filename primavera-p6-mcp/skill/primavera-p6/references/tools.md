# Tool reference

Generated from the tool definitions. Run `node scripts/p6.mjs help <tool>` to print one tool's arguments.

Durations and floats are working days. Dates are as P6 exported them.

## `xer_list_files`

Find .xer files in a folder (default: the working folder), newest first.

| Argument | Type | Notes |
| --- | --- | --- |
| `folder` | string | Folder to search; defaults to the working folder |
| `recursive` | boolean | default `false` |

## `xer_open`

Load an XER file and list the projects and tables in it. Call this first to see what an XER contains; the other xer_* tools load the file on demand too.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |

## `xer_project_summary`

Key facts about a project in an XER: data date, start and finish, must-finish-by, activity counts by status and type, percent complete, critical and negative-float counts, cost totals.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `criticalFloat` | number | Total float (days) at or below which an activity counts as critical. default `0` |

## `xer_list_activities`

Activities in the project, ordered by start, with optional filters. Durations and floats are working days; dates are P6 dates (actual where they exist, otherwise forecast).

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
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
| `limit` | integer | range 1–5000. default `200` |
| `offset` | integer | range 0–9007199254740991. default `0` |

## `xer_get_activity`

Everything about one activity: dates, durations, floats, constraint, calendar, WBS path, predecessors, successors and resource assignments.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `activityId` | string | **required**. Activity ID as shown in P6, e.g. A1010 |

## `xer_wbs`

The project's WBS as a tree, with activity count, start, finish and lowest total float under each element.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `maxDepth` | integer | range 0–20. default `10` |

## `xer_critical_path`

Incomplete activities with total float at or below a threshold (default 0) or on P6's longest path, in start order.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `floatThreshold` | number | Days of total float that still count as critical. default `0` |
| `includeCompleted` | boolean | default `false` |

## `xer_driving_path`

Trace the chain of driving predecessors back from an activity (default: the one that finishes last) to the data date. Use it to explain why a milestone finishes when it does.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `activityId` | string | Target activity ID; defaults to the latest-finishing incomplete activity |

## `xer_schedule_health`

Run the DCMA 14-point assessment: logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI and BEI. Each check lists offending activities. Pass a baseline XER for checks 11 and 14; otherwise planned dates are used.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `baselineFile` | string | XER of the baseline schedule, matched by activity ID |
| `baselineProject` | string |  |

## `xer_compare`

Compare two XERs of the same project (e.g. last month's update and this month's): finish slip, data date move, activities added and removed, changed durations, dates, float, status and constraints, and logic added, removed or with changed lag. Matching is by activity ID.

| Argument | Type | Notes |
| --- | --- | --- |
| `previousFile` | string | **required**. Earlier XER (baseline or previous update) |
| `currentFile` | string | **required**. Later XER |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `previousProject` | string | Project ID in the earlier file if it differs |
| `limit` | integer | Maximum items per list. range 1–5000. default `100` |

## `xer_lookahead`

Incomplete activities that are in progress, start or finish within the next N days from the data date (or a given date). Good for 2-, 3- or 6-week look-aheads.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |
| `days` | integer | range 1–366. default `21` |
| `from` | string | YYYY-MM-DD; defaults to the data date |

## `xer_resources`

Resources assigned in the project with planned, actual and remaining units and costs.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `project` | string | Project ID (short name) when the XER holds more than one project |

## `xer_query_table`

Read rows from any table in the XER (e.g. TASK, TASKPRED, PROJWBS, CALENDAR, RSRC, TASKRSRC, ACTVCODE, TASKACTV, UDFVALUE) with field names as P6 exports them. Use it for data the other tools don't cover.

| Argument | Type | Notes |
| --- | --- | --- |
| `file` | string | **required**. Path to the .xer file (absolute, or relative to the working folder) |
| `table` | string | **required**. Table name, e.g. TASK |
| `where` | object of strings | Exact-match filters, e.g. { "proj_id": "4512" } |
| `contains` | string | Keep rows where any field contains this text (case-insensitive) |
| `fields` | string[] | Fields to return; default all |
| `limit` | integer | range 1–5000. default `200` |
| `offset` | integer | range 0–9007199254740991. default `0` |
