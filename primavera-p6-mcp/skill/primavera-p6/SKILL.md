---
name: primavera-p6
description: Analyse Oracle Primavera P6 schedules from XER export files. Use when the user shares or mentions a P6 XER file and wants a status summary, critical or driving path, DCMA 14-point schedule health check, comparison of two updates (what slipped and why), look-ahead, resource loading, WBS view, or raw table data. Triggers on "XER", "Primavera", "P6", "schedule update", "critical path", "DCMA", "float", "look-ahead", "baseline vs update".
---

# Primavera P6 (XER analysis)

Everything runs through one bundled script, `scripts/p6.mjs`. It needs Node.js 18 or later and nothing else.

```bash
node scripts/p6.mjs list                                    # the tools
node scripts/p6.mjs help <tool>                             # one tool's arguments
node scripts/p6.mjs <tool> --file schedule.xer [--name value ...]
node scripts/p6.mjs <tool> '{"file":"schedule.xer","maxFloat":0}'   # JSON form, for lists and objects
```

Paths are absolute or relative to the current directory. Each tool prints JSON on stdout. If something is wrong, the script prints the reason on stderr and exits with code 1. `references/tools.md` lists every tool and argument.

Durations and floats are **working days**. Dates are as P6 exported them: actual dates where they exist, otherwise forecast (early) dates.

## Permissions and data access

- **Reads** only the `.xer` files and folders named in the command. Its own `scripts/tools.json` holds the argument definitions.
- **Writes nothing.** It never creates, changes or deletes files.
- **No network access.** It makes no HTTP or other outbound calls.
- **No environment variables, no credentials.** It reads only its command-line arguments.
- **Runs no other programs** and evaluates no code.

The skill works only on exported files and doesn't connect to a P6 server. To read or change a live P6 EPPM database, the user needs the separate Primavera P6 MCP server, which is published with this skill.

## Workflows

**"What's in this XER / give me a status"**
1. Run `xer_open` to see the projects and tables. If there's more than one project, pass `--project <ID>` from then on.
2. Run `xer_project_summary` for the data date, the forecast finish against the must-finish date, % complete and negative float.
3. Run `xer_driving_path`. With no activity it traces to the project finish, which explains what drives completion.

Report the finish against the target date in calendar days, name the driving chain, and give the worst float. Keep it to a short paragraph, plus a small table if useful.

**"Is this schedule any good" / DCMA**
Run `xer_schedule_health`. Pass `--baselineFile` if the user has a baseline XER. Otherwise, say that missed tasks and BEI were measured against planned dates. Report it as a 14-row table (check, value, threshold, pass/fail), then list the fixes. Each check lists its offending activities in `examples`. Use `references/dcma.md` to explain what each failure means and how a scheduler fixes it. Report checks with `pass: null` as not applicable, not as passed.

**"What changed since last month / why did it slip"**
Run `xer_compare --previousFile old.xer --currentFile new.xer` and lead with `projectFinishSlipDays`. Then explain the slip from:
- the activities with the biggest `finishSlipDays`
- logic changes
- added activities
- duration changes on the driving path (run `xer_driving_path` on the new file)

Separate progress problems (in-progress work that took longer than planned) from planning changes (new logic, longer durations, new activities).

**Look-ahead / work planning**
Run `xer_lookahead --days 14` (or 21, or 42). Group the results by WBS (the `wbs` field) or by resource when asked. Flag items with zero or negative float.

**Find specific activities**
`xer_list_activities` filters by `status`, `types`, `wbs`, `search`, `maxFloat`/`minFloat`, `longestPathOnly`, `startsAfter`/`finishesBefore`, `hasConstraint` and `resource`. `xer_get_activity` returns one activity's logic, constraints and resources. For anything else, such as activity codes, UDFs or calendars, use `xer_query_table --table TASKACTV` (or another table name). Field names there are P6's raw names, e.g. `task_code` and `total_float_hr_cnt`.

## Reading results

- Lists are paged. Check `total` and `truncated`, and raise `--limit` or use `--offset` rather than guessing at missing rows.
- Negative `totalFloat` means the activity can't meet a constraint or the must-finish date. 0 is critical. Large float often means missing logic.
- The driving path is traced from exported dates and counts Monday to Friday, or seven days on a seven-day calendar. XER files don't record holidays, so a `gapDays` of 1 can be a holiday rather than a logic gap.
- `xer_compare` matches activities by ID. Slips are in calendar days; positive means later.
- These results approximate P6's own scheduling calculation. If the user needs P6's exact critical path or reschedule result, say so.

## Try it

`examples/` holds two monthly updates of a small office-building project. Some typical faults are planted in them: a lead, a lag, a hard constraint, an open end, negative float, a missed task and a long-duration activity.

```bash
node scripts/p6.mjs xer_schedule_health --file examples/office-building-update1.xer
node scripts/p6.mjs xer_compare --previousFile examples/office-building-update1.xer --currentFile examples/office-building-update2.xer
```
