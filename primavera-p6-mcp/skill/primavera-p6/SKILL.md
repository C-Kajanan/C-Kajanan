---
name: primavera-p6
description: Analyse and update Oracle Primavera P6 schedules. Use when the user shares or mentions a P6 XER file or a P6 project and wants a status summary, critical or driving path, DCMA 14-point schedule health check, comparison of two updates (what slipped and why), look-ahead, resource loading, or WBS view; or wants to read or change a live P6 EPPM project (activities, logic, progress, rescheduling) through the P6 REST API. Triggers on "XER", "Primavera", "P6", "schedule update", "critical path", "DCMA", "float", "look-ahead", "baseline vs update".
---

# Primavera P6

Everything runs through one bundled script, `scripts/p6.mjs`. It needs Node.js 18 or later and nothing else. You don't have to install anything.

```bash
node scripts/p6.mjs list                                   # tools available right now
node scripts/p6.mjs <tool> --file schedule.xer [--name value ...]
node scripts/p6.mjs <tool> '{"file":"schedule.xer","maxFloat":0}'   # JSON form, for arrays/objects
node scripts/p6.mjs help <tool>                            # argument schema of one tool
```

Paths are relative to the current directory, or to `P6_XER_DIR` if it's set. Every tool prints JSON on stdout. Errors go to stderr with exit code 1, and the message says what to fix. `references/tools.md` lists every tool and its arguments.

## Two modes

**XER files (default).** These are the `xer_*` tools. They need only the file and work offline. Use them whenever the user has an `.xer` export. Durations and floats are **working days**. Dates are P6's: actual dates where they exist, otherwise forecast (early) dates.

**Live P6.** These are the `p6_*` tools. They need `P6_BASE_URL` (e.g. `https://host/p6ws/restapi`) and either `P6_USERNAME`, `P6_PASSWORD` and `P6_DATABASE`, or `P6_AUTH_TOKEN` for Oracle Cloud. Durations, floats and lags here are **hours**. Tools that change P6 appear only when `P6_ALLOW_WRITES=1`. Never set that variable yourself: the user decides. For in-depth analysis of a live project, export it with `p6_export_xer` and run the `xer_*` tools on the file. See `references/p6-rest.md` for filter syntax, field names and payloads.

## Workflows

**"What's in this XER / give me a status"**
1. `xer_open`: projects and tables. If there's more than one project, pass `--project <ID>` from then on.
2. `xer_project_summary`: data date, forecast finish against must-finish-by, % complete, negative float.
3. `xer_driving_path` (with no activity it uses the project finish): explain what drives completion.
Report the finish against the target date in calendar days, name the driving chain, and give the worst float. Keep it to a short paragraph plus a small table if useful.

**"Is this schedule any good" / DCMA**
Run `xer_schedule_health`. Pass `--baselineFile` if the user has a baseline XER; otherwise say that missed tasks and BEI were measured against planned dates. Report it as a 14-row table (check, value, threshold, pass or fail), then the fixes. Each check lists offending activities in `examples`. Use `references/dcma.md` to explain what each failure means and how a scheduler fixes it. Mark checks with `pass: null` as not applicable rather than passed.

**"What changed since last month / why did it slip"**
Run `xer_compare --previousFile old.xer --currentFile new.xer`. Lead with `projectFinishSlipDays`. Then explain the slip using the activities with the biggest `finishSlipDays`, plus the logic changes, added activities and duration changes on the driving path (`xer_driving_path` on the new file). Separate genuine progress problems (in-progress work that took longer than planned) from planning changes (new logic, longer durations, new activities).

**Look-ahead / work planning**
Run `xer_lookahead --days 14` (or 21 or 42). Group by WBS (`wbs` field) or resource when the user asks. Flag items with negative or zero float.

**Find specific activities**
`xer_list_activities` filters by `status`, `types`, `wbs`, `search`, `maxFloat`/`minFloat`, `longestPathOnly`, `startsAfter`/`finishesBefore`, `hasConstraint` and `resource`. Use `xer_get_activity` for one activity's logic, constraints and resources. For anything else (activity codes, UDFs, calendars) use `xer_query_table --table TASKACTV` and similar. The raw field names are P6's (e.g. `task_code`, `total_float_hr_cnt`).

**Change a live project** (only when the user asks and writes are enabled)
1. Read first: `p6_list_activities --projectId <ID>` or `p6_get_activity` to get `ObjectId`s and current values.
2. Say exactly what you'll change: activity, field, old value and new value, with durations in **hours**. Wait for the user's go-ahead.
3. Apply it with `p6_update_activities` / `p6_create_relationships` / and so on, using the JSON argument form.
4. Run `p6_schedule_project` (F9) if dates should move, then re-read and report what moved.
Don't delete anything unless the user named it.

## Reading results

- Lists are paged. Check `total` and `truncated`, and raise `--limit` or use `--offset` rather than guessing at missing rows.
- `totalFloat` below 0 means the activity can't meet a constraint or must-finish date. 0 is critical. Large float often means missing logic.
- The driving path is traced from exported dates and counts Monday to Friday (or seven days on a seven-day calendar). XER files don't record holidays, so a `gapDays` of 1 can be a holiday rather than a logic gap.
- `xer_compare` matches activities by ID. Slips there are calendar days; positive means later.
- The tools give approximations, not P6's own calculation. If the user needs P6's exact critical path or reschedule result, say so and use the live tools or P6 itself.

## Try it

`examples/` holds two monthly updates of a small office-building project with some faults planted in it: a lead, a lag, a hard constraint, an open end, negative float, a missed task and a long-duration activity. For a demo, run:

```bash
node scripts/p6.mjs xer_schedule_health --file examples/office-building-update1.xer
node scripts/p6.mjs xer_compare --previousFile examples/office-building-update1.xer --currentFile examples/office-building-update2.xer
```
