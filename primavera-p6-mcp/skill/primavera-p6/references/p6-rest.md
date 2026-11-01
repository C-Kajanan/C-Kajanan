# P6 EPPM REST API notes (for the `p6_*` tools)

## Connection

| Variable | Purpose |
| --- | --- |
| `P6_BASE_URL` | `https://<host>:<port>/p6ws/restapi` |
| `P6_DATABASE` | Database name sent to `/login?DatabaseName=` |
| `P6_USERNAME`, `P6_PASSWORD` | Session login (headers `username` / `password`), cookie reused |
| `P6_AUTH_TOKEN` | Oracle Cloud OAuth token, sent as `Authorization: Bearer`; replaces username/password |
| `P6_LOGIN_MODE=basic` | Older releases that expect HTTP Basic on `/login` |
| `P6_ALLOW_WRITES=1` | Enables create/update/delete/schedule tools. The user sets this, never you |
| `NODE_EXTRA_CA_CERTS` | CA certificate path for internal or self-signed TLS |

Run `p6_connection_info` first to confirm the login works.

## Units

The API reports durations (`PlannedDuration`, `RemainingDuration`), floats (`TotalFloat`, `FreeFloat`) and lags (`Lag`) in **hours**. Convert with the activity calendar's hours per day (usually 8; check with `p6_list_calendars`). Dates are ISO, e.g. `2026-03-02T08:00:00`.

## Filters

The `filter` argument is P6 filter syntax and is combined with each tool's own filter using `:and:`.

```
Status :eq: 'In Progress'
TotalFloat :lt: 0
StartDate :gte: '2026-04-01' :and: StartDate :lt: '2026-05-01'
Name :like: 'Pour%'
ObjectId IN(101,102,103)
```

Operators: `:eq:` `:gt:` `:lt:` `:gte:` `:lte:` `:like:` (with `%` wildcards), `IN(...)`, joined with `:and:` / `:or:`. Put strings in single quotes.

`orderBy` takes a field and direction, e.g. `StartDate asc`. `fields` takes P6 field names. The defaults cover the usual needs.

## Useful activity fields

`ObjectId, Id, Name, Status, Type, WBSCode, WBSName, PlannedDuration, RemainingDuration, ActualDuration, StartDate, FinishDate, ActualStartDate, ActualFinishDate, EarlyStartDate, EarlyFinishDate, LateStartDate, LateFinishDate, PlannedStartDate, PlannedFinishDate, BaselineStartDate, BaselineFinishDate, TotalFloat, FreeFloat, PercentComplete, PhysicalPercentComplete, PrimaryConstraintType, PrimaryConstraintDate, SecondaryConstraintType, SecondaryConstraintDate, IsCritical, IsLongestPath, CalendarName, PrimaryResourceName, ProjectObjectId, WBSObjectId`

Enumerations:
- `Status`: `Not Started`, `In Progress`, `Completed`
- `Type`: `Task Dependent`, `Resource Dependent`, `Level of Effort`, `Start Milestone`, `Finish Milestone`, `WBS Summary`
- `PrimaryConstraintType`: `Start On`, `Start On or Before`, `Start On or After`, `Finish On`, `Finish On or Before`, `Finish On or After`, `As Late As Possible`, `Mandatory Start`, `Mandatory Finish`
- Relationship `Type`: `Finish to Start`, `Start to Start`, `Finish to Finish`, `Start to Finish`

For other objects use `p6_read --entity <name>` with explicit `fields`, for example `activityCode`, `activityCodeAssignment`, `udfValue`, `baselineProject`, `activityNote`, `projectIssue` or `risk`.

## Write payloads (JSON argument form)

Progress an activity, then reschedule:

```bash
node scripts/p6.mjs p6_update_activities '{"activities":[{"ObjectId":9001,"ActualStartDate":"2026-03-09T08:00:00","RemainingDuration":40,"PhysicalPercentComplete":50}]}'
node scripts/p6.mjs p6_schedule_project '{"projectId":"OFFICE-01","newDataDate":"2026-03-30T08:00:00"}'
```

Add a finish-to-start link with 2 days' lag (16 h):

```bash
node scripts/p6.mjs p6_create_relationships '{"relationships":[{"PredecessorActivityObjectId":9001,"SuccessorActivityObjectId":9002,"Type":"Finish to Start","Lag":16}]}'
```

Create a milestone:

```bash
node scripts/p6.mjs p6_create_activities '{"activities":[{"ProjectObjectId":4512,"WBSObjectId":7001,"Id":"M9100","Name":"Handover","Type":"Finish Milestone"}]}'
```

Every update needs `ObjectId`. Look it up first with `p6_list_activities` or `p6_get_activity` (`--activityId A1010 --projectId OFFICE-01`).
