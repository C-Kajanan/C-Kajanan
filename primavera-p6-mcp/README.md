# Primavera P6 MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for Oracle Primavera P6. It lets Claude (or any MCP client) work with your schedules in two ways:

- **XER files, offline.** Point it at an `.xer` export and ask about it: project summary, critical and driving paths, DCMA 14-point health check, look-aheads, resource loading, and a comparison of two updates. You don't need a P6 login for this.
- **Live P6 EPPM, through the REST API.** List projects, WBS, activities, relationships and resources; export a project to XER; and, if you turn writes on, update activities and logic and run the scheduler (F9).

```
 Claude / MCP client ──stdio──▶ primavera-p6-mcp (Node) ──▶ .xer files on disk
                                                      └──HTTPS──▶ P6 EPPM REST API (/p6ws/restapi)
```

Try it on the sample project in [`examples/`](examples): two monthly updates of a small office-building schedule with some typical problems planted in it (a lead, a lag, a hard constraint, an open end, negative float, a missed task).

## Install

You need [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/C-Kajanan/C-Kajanan.git
cd C-Kajanan/primavera-p6-mcp/server
npm install
npm run build
```

### Connect your MCP client

Claude Code, XER files only:

```bash
claude mcp add p6 -e P6_XER_DIR=/path/to/your/xer/files -- node /path/to/C-Kajanan/primavera-p6-mcp/server/build/index.js
```

Claude Desktop (`claude_desktop_config.json`), with a live P6 server:

```json
{
  "mcpServers": {
    "primavera-p6": {
      "command": "node",
      "args": ["C:/path/to/C-Kajanan/primavera-p6-mcp/server/build/index.js"],
      "env": {
        "P6_XER_DIR": "C:/Schedules",
        "P6_BASE_URL": "https://p6.example.com/p6ws/restapi",
        "P6_DATABASE": "PMDB",
        "P6_USERNAME": "planner",
        "P6_PASSWORD": "••••••"
      }
    }
  }
}
```

Leave out the `P6_*` server variables if you only want XER analysis. Then ask Claude something like:

- "Open `office-building-update2.xer` and give me a one-paragraph status: data date, forecast finish against the must-finish date, and what's driving it."
- "Run a DCMA 14-point check and list the activities I need to fix, worst first."
- "Compare update 1 with update 2. Why did completion slip, and what logic changed?"
- "Give me a three-week look-ahead grouped by WBS, with the resources on each activity."
- "Trace the driving path to M9000."
- "Export project OFFICE-01 from P6 and check it for open ends and hard constraints."
- With writes on: "Set the remaining duration of A2020 to 5 days and reschedule the project with data date 30 March."

## Tools

### XER files

Durations and floats are **working days** of each activity's calendar. Dates are as P6 exported them: actual dates where they exist, otherwise forecast (early) dates.

| Tool | What it does |
| --- | --- |
| `xer_list_files` | Find `.xer` files in a folder |
| `xer_open` | Projects and tables in a file |
| `xer_project_summary` | Data date, start, finish, must-finish-by, counts by status and type, % complete, critical and negative-float counts, cost |
| `xer_list_activities` | Filter by status, type, WBS, text, float range, dates, constraint, resource |
| `xer_get_activity` | One activity with predecessors, successors, constraints and resources |
| `xer_wbs` | WBS tree with dates, activity count and lowest float per element |
| `xer_critical_path` | Activities at or below a float threshold, or on P6's longest path |
| `xer_driving_path` | Chain of driving predecessors back from an activity to the data date |
| `xer_schedule_health` | DCMA 14-point assessment, with offending activities for each check |
| `xer_compare` | Two updates side by side: finish slip, added/removed activities, changed durations, dates, float, status, constraints and logic |
| `xer_lookahead` | Work in progress, starting or finishing in the next N days |
| `xer_resources` | Planned, actual and remaining units and cost per resource |
| `xer_query_table` | Raw rows from any XER table (activity codes, UDFs, calendars, ...) |

### Live P6 (needs `P6_BASE_URL`)

The P6 API reports durations, floats and lags in **hours**.

| Tool | What it does |
| --- | --- |
| `p6_connection_info` | Log in and check the connection |
| `p6_list_projects` / `p6_list_eps` | Projects and the EPS |
| `p6_list_wbs` | WBS of a project |
| `p6_list_activities` | Activities, with status / critical / WBS filters or any P6 filter |
| `p6_get_activity` | One activity with its relationships and resource assignments |
| `p6_list_relationships` | Logic of a project or activity, with driving flags |
| `p6_list_resources` / `p6_list_resource_assignments` / `p6_list_calendars` | Resources, assignments, calendars |
| `p6_read` | Any other P6 REST object (activity codes, UDF values, baselines, notes, risks, ...) |
| `p6_export_xer` | Export one or more projects to an XER file for the `xer_*` tools |
| `p6_job_status` | Status of a scheduling or export job |

Tools that take a project accept either `projectObjectId` or the project ID you see in P6 (`projectId`). Filters use P6 syntax, for example `TotalFloat :lt: 0 :and: Status :eq: 'Not Started'`.

### Changing P6 (needs `P6_ALLOW_WRITES=1`)

These tools are only offered when you set `P6_ALLOW_WRITES=1`.

| Tool | What it does |
| --- | --- |
| `p6_update_activities` | Change fields: names, durations, constraints, progress (actual dates, remaining duration, % complete) |
| `p6_create_activities` / `p6_delete_activities` | Add or remove activities |
| `p6_create_relationships` / `p6_update_relationships` / `p6_delete_relationships` | Edit logic |
| `p6_create_resource_assignments` | Assign resources |
| `p6_schedule_project` | Run the scheduler (F9), optionally with a new data date, and wait for it |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `P6_XER_DIR` | server's working directory | Where relative XER paths are resolved, and where exports are saved |
| `P6_BASE_URL` | unset | P6 REST API base, e.g. `https://host:port/p6ws/restapi`. Unset means XER tools only |
| `P6_DATABASE` | unset | Database name passed to `/login` (`DatabaseName`) |
| `P6_USERNAME` / `P6_PASSWORD` | unset | P6 user for session login |
| `P6_AUTH_TOKEN` | unset | OAuth token for Oracle Cloud, sent as `Authorization: Bearer`. Used instead of username/password |
| `P6_LOGIN_MODE` | `headers` | `basic` sends the credentials as HTTP Basic auth, for older P6 releases |
| `P6_ALLOW_WRITES` | unset | `1` to offer the tools that change P6 |
| `P6_TIMEOUT_MS` | `120000` | HTTP timeout |
| `NODE_EXTRA_CA_CERTS` | unset | Path to your CA certificate if the P6 server uses an internal or self-signed one |

## How the analysis works

- **Critical path**: incomplete activities with total float at or below the threshold (default 0), plus any P6 flagged as on the longest path when it scheduled.
- **Driving path**: starting at the target activity, the tool repeatedly picks the predecessor whose relationship leaves the smallest gap in working days and stops at an activity that has started. The gap counts Monday to Friday (or all seven days on a seven-day calendar). The XER doesn't say which days are holidays, so a gap of 1 can be a holiday.
- **DCMA 14-point**: the standard thresholds (logic ≤ 5%, leads 0, lags ≤ 5%, FS ≥ 90%, hard constraints ≤ 5%, high float ≤ 5%, negative float 0, high duration ≤ 5%, invalid dates 0, resources, missed tasks ≤ 5%, critical path test, CPLI ≥ 0.95, BEI ≥ 0.95), over incomplete activities, leaving out level-of-effort and WBS summary activities. Missed tasks and BEI use the planned dates unless you pass `baselineFile`, in which case activities are matched by ID with the baseline XER. The critical path test is an approximation from exported dates: it checks for a continuous driving chain from the data date to the finish. DCMA's version adds delay and reschedules, which only P6 can do.
- **Compare**: activities are matched by activity ID and relationships by predecessor, successor and type. Slips are calendar days.

XER files are read as Windows-1252 unless they are valid UTF-8. Parsed files are cached until they change on disk.

## Security

- Your credentials stay in your MCP client's config and are only sent to `P6_BASE_URL`. Use a P6 user whose security profile only gives access to the projects you want the assistant to see.
- Write tools are off by default. With them on, the assistant can change and delete data in P6. Try it on a copy of the project first, and review each tool call before you approve it.
- XER tools only read files. `p6_export_xer` writes the file you name.

## Development

```bash
cd server
npm install
npm test     # builds, then runs unit tests on the sample XERs and MCP tests against a mock P6 server
```

The REST client follows Oracle's [P6 EPPM REST API](https://docs.oracle.com/cd/G18294_01/English/Integration_Documentation/rest_api/D99665.html) reference (release 25). To add a tool, add an entry to `server/src/tools/xerTools.ts` or `server/src/tools/p6Tools.ts`.

## License

MIT
