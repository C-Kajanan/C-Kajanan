# SAP2000 MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for CSi SAP2000. It lets Claude (or any MCP client) drive the SAP2000 you have open: build a model, define materials, sections and loads, run the analysis, and read displacements, reactions, member forces, modal periods and steel design ratios.

```
 Claude / MCP client ──stdio──▶ sap2000-mcp (Python) ──COM / CSi OAPI──▶ SAP2000 (Windows)
```

It uses the official SAP2000 API (OAPI) through COM, so no SAP2000 plug-in is needed. It attaches to the SAP2000 window that is already open, or starts one if you ask it to.

## Requirements

- Windows with **SAP2000 v20 or later** (v23–v26 recommended)
- **Python 3.10+**
- The SAP2000 API registered. SAP2000's installer normally does this. If `connect` reports that `SAP2000v1.Helper` can't be loaded, run `RegisterSAP2000.exe` from the SAP2000 install folder as administrator.

Python and SAP2000 must both be 64-bit (the default for both).

## Install as one Claude Code plugin (recommended)

This folder is also a Claude Code plugin named `sap2000`. One install gives you the MCP server **and** a `sap2000` skill that teaches Claude the SAP2000 workflow: units, sign conventions, load combinations, result sanity checks and how to report.

You need [uv](https://docs.astral.sh/uv/getting-started/installation/) (`winget install astral-sh.uv`). The plugin uses it to install and start the server.

```
/plugin marketplace add C-Kajanan/C-Kajanan
/plugin install sap2000@c-kajanan
```

Restart Claude Code, open SAP2000, and ask away. The skill loads by itself whenever you talk about SAP2000 or structural modelling, or you can type `/sap2000`.

| Part | File |
| --- | --- |
| Skill | [`skills/sap2000/SKILL.md`](skills/sap2000/SKILL.md) |
| MCP server config | [`.mcp.json`](.mcp.json) |
| Plugin manifest | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) |
| Marketplace (repo root) | [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) |

## Install the MCP server only

Use this for Claude Desktop or other MCP clients.

```powershell
git clone https://github.com/C-Kajanan/C-Kajanan.git
cd C-Kajanan\sap2000-mcp
python -m venv .venv
.venv\Scripts\pip install .
```

This puts `sap2000-mcp.exe` in `.venv\Scripts\`.

### Connect your MCP client

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sap2000": {
      "command": "C:/path/to/C-Kajanan/sap2000-mcp/.venv/Scripts/sap2000-mcp.exe"
    }
  }
}
```

Claude Code:

```powershell
claude mcp add sap2000 -- C:/path/to/C-Kajanan/sap2000-mcp/.venv/Scripts/sap2000-mcp.exe
```

With [uv](https://docs.astral.sh/uv/) you can skip the venv and run it straight from GitHub:

```json
{
  "mcpServers": {
    "sap2000": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/C-Kajanan/C-Kajanan#subdirectory=sap2000-mcp", "sap2000-mcp"]
    }
  }
}
```

Open SAP2000, then ask Claude something like:

- "Make a 2D portal frame, 1 bay of 6 m and 1 storey of 4 m, in kN and m. Use S355 steel and IPE300 beams, HEA200 columns, fixed bases. Add 1.0×self weight as DEAD and 15 kN/m LIVE on the beam, combine 1.35D + 1.5L, run it and tell me the max moment and the support reactions."
- "What load cases and combinations are in this model? Which frame has the highest steel design ratio?"
- "List the first 10 modes with periods."
- "Read the 'Joint Coordinates' table."

## Tools

Values are in the model's **present units** (see `get_model_info`, change with `set_units`). Units names: `lb_in_F`, `lb_ft_F`, `kip_in_F`, `kip_ft_F`, `kN_mm_C`, `kN_m_C`, `kgf_mm_C`, `kgf_m_C`, `N_mm_C`, `N_m_C`, `Ton_mm_C`, `Ton_m_C`, `kN_cm_C`, `kgf_cm_C`, `N_cm_C`, `Ton_cm_C`.

| Area | Tool | Description |
| --- | --- | --- |
| Session | `connect` | Attach to the running SAP2000, or start one with `start_new=true` |
| | `disconnect` | Release SAP2000, optionally exit it |
| | `get_model_info` | Version, file, units, lock state, object counts |
| | `set_units` | Change the present units |
| File | `new_model` | Blank, grid only, 2D frame (portal / braced) or 3D frame (open, perimeter, beam-slab, flat plate) template |
| | `open_model` / `save_model` | Open or save `.sdb` files |
| | `refresh_view` | Redraw SAP2000's windows |
| Geometry | `add_point`, `add_frame`, `add_frames`, `add_area` | Joints, frames (by coordinates or joints), many frames at once, shells |
| | `list_points`, `list_frames`, `list_areas` | Coordinates, restraints, connectivity, sections, lengths |
| | `delete_objects` | Delete frames or areas |
| | `set_restraints` | `fixed`, `pinned`, `roller`, `free` or any 6 DOFs |
| | `get_selection` | What's selected in the SAP2000 window |
| Properties | `add_material`, `list_materials` | Code materials (e.g. `ASTM A992 / Grade 50`, `EN 1992-1-1 / C30/37`) or isotropic E, ν |
| | `add_frame_section`, `list_frame_sections` | Rectangle, circle, pipe, tube, I-section, or import from `AISC16.xml`, `Euro.xml`, … |
| | `add_shell_section`, `list_area_sections` | Shell thin/thick, plate, membrane |
| | `assign_frame_section`, `assign_area_section` | Assign sections |
| Loads | `add_load_pattern`, `list_loads` | Patterns (dead, live, wind, quake, …), cases and combinations |
| | `assign_joint_load` | Forces and moments on joints |
| | `assign_frame_distributed_load`, `assign_frame_point_load` | Uniform/trapezoidal and concentrated member loads |
| | `assign_area_uniform_load` | Pressure on shells |
| | `add_load_combination` | Linear add, envelope, absolute, SRSS, range |
| Analysis | `run_analysis` | Run all or chosen cases; returns each case's status |
| | `unlock_model` | Unlock for editing (deletes results) |
| Results | `get_joint_displacements`, `get_joint_reactions` | Per joint, for cases or combinations |
| | `get_base_reactions` | Total base reactions |
| | `get_frame_forces` | P, V2, V3, T, M2, M3 along members |
| | `get_modal_periods` | Periods, frequencies, eigenvalues |
| Design | `run_design` | Steel or concrete frame design |
| | `get_steel_design_summary` | Ratios per frame, worst first |
| Tables | `list_tables`, `get_table` | Any interactive database table |
| Advanced | `sap_api` | Call any `SapModel` OAPI method directly, e.g. `FrameObj.SetReleases` |

Results tools accept load case **and** combination names; use `names: ["ALL"]` (the default) for every object. Large results are truncated to `limit` rows and say so.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAP2000_MCP_START` | `0` | `1` = start SAP2000 automatically if none is running |
| `SAP2000_PATH` | unset | Full path to `SAP2000.exe` for a non-default install (used when starting a new instance) |

## Notes and safety

- The assistant can change and delete objects, and `new_model` / `open_model` replace the open model without saving it. Work on a copy and review tool calls before you approve them.
- `run_analysis` needs a saved model; ask Claude to `save_model` to a path first.
- Editing a model after analysis unlocks it, and SAP2000 deletes the results.
- `sap_api` can call any OAPI method, so it can do anything the API can. Your MCP client asks before each call.
- All COM calls run on one dedicated thread, so a long analysis doesn't freeze the MCP connection.

## Troubleshooting

- **"Could not find a running SAP2000"**: open SAP2000 first, or call `connect` with `start_new=true`.
- **"Could not load the SAP2000 API (SAP2000v1.Helper)"**: run `RegisterSAP2000.exe` as administrator, and check that Python is 64-bit (`python -c "import struct; print(struct.calcsize('P')*8)"`).
- **"Lost the connection to SAP2000"**: SAP2000 was closed. Reopen it and call `connect`.
- **A call returns "failed (SAP2000 returned 1)"**: SAP2000 rejected the input, often an unknown name (section, material, pattern) or a locked model. Check with the `list_*` tools.

## Development

The tests run on any OS against an in-memory fake of the OAPI (`tests/fake_sap.py`), over the real MCP protocol:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
```

To add a tool, add a function decorated with `@tool` in `src/sap2000_mcp/server.py`. Put COM work inside `await conn.run(lambda m: ...)`, where `m` is `SapModel`, and wrap OAPI calls in `check(...)`, which raises on a non-zero return code and gives you the ByRef outputs.

## License

MIT
