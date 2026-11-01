# DCMA 14-point assessment: what each check means and how to fix it

`xer_schedule_health` runs these checks on incomplete activities. It leaves out level-of-effort and WBS summary activities. For each finding, give the user the cause and a concrete fix, naming activity IDs from `examples`.

| # | Check | Threshold | What a failure usually means | Typical fix |
| --- | --- | --- | --- | --- |
| 1 | Logic | ≤ 5% open ends | Activities with no predecessor or no successor. Delays don't flow through them, so float and the critical path are wrong. The project start and finish milestones are expected open ends. | Add the missing links. Every activity should have a predecessor and a successor, and anything that finishes should feed something or the finish milestone. |
| 2 | Leads | 0 | Negative lag (a successor starting before its predecessor finishes) hides overlap and is hard to status. | Split the predecessor and use FS logic from the part that actually enables the successor, or use SS with a positive lag. |
| 3 | Lags | ≤ 5% | Lags stand in for real work or waiting time (curing, approvals) that can't be tracked or progressed. | Replace long or frequent lags with activities, such as "Concrete cure 7d" or "Client review 10d". |
| 4 | Relationship types | ≥ 90% FS | Too many SS/FF/SF links make the path hard to follow and can create dangling logic. | Use FS where the work is really sequential. Keep SS/FF in pairs (SS + FF) for overlapping work. |
| 5 | Hard constraints | ≤ 5% | Start On, Finish On, On or Before and Mandatory constraints override the logic, so float is artificial and delays don't push dates. | Remove them, or replace them with soft constraints ("Start On or After") or a deadline on a milestone. Drive dates with logic. |
| 6 | High float | ≤ 5% with TF > 44 d | Usually missing successors or an activity tied only to the project end. | Check successors and link the activity to the work it really enables. |
| 7 | Negative float | 0 | The forecast can't meet a constraint or the must-finish date. Report this as a schedule problem, not a data problem. | Look for recovery on the driving path (`xer_driving_path`): re-sequencing, more resources, shorter durations. Or agree a new date and move the constraint. |
| 8 | High duration | ≤ 5% with OD > 44 d | Activities too long to plan and status accurately. | Break them into shorter activities by area, level or system. |
| 9 | Invalid dates | 0 | Actual dates after the data date, or forecast dates before it. The update wasn't statused or scheduled correctly. | Fix the actuals, then reschedule (F9) with the right data date. |
| 10 | Resources | 0 without resources | Only applies when the schedule is resource-loaded. Activities with duration but no resources. | Assign resources or roles, or confirm with the user that the schedule is deliberately not resource-loaded. |
| 11 | Missed tasks | ≤ 5% | Activities that should have finished by the data date (baseline or planned) and didn't. This is a performance indicator. | Report it. It is measured against planned dates unless a baseline XER was passed. |
| 12 | Critical path test | continuous path | No continuous driving chain from the data date to the finish, or gaps on it. The finish isn't really driven by the work. | Find the break in the path output (gaps over 1 day, or an activity with no driving predecessor) and fix the logic or the constraint causing it. |
| 13 | CPLI | ≥ 0.95 | (critical path length + total float) / critical path length. Below 1 means the finish date can't be met at the current rate. | As for negative float, plus recovery planning. |
| 14 | BEI | ≥ 0.95 | Activities completed divided by activities that should have completed by now. Below 0.95 means the project is falling behind its plan. | Report the trend, comparing with the previous update via `xer_compare`. |

Notes for the user:
- These are guidelines from the US Defense Contract Management Agency's assessment and are widely used in construction. They aren't hard rules. A failed check is a prompt to look, not proof that the schedule is wrong.
- Check 12 here is an approximation from exported dates. DCMA's own test adds delay to a critical activity and confirms the finish moves by the same amount, which needs P6 to reschedule.
