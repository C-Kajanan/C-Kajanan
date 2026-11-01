---
name: sap2000
description: Build, analyse and check structural models in CSi SAP2000 through the bundled sap2000 MCP tools. Use when the user mentions SAP2000, or asks to model a frame, truss, beam, slab or building, apply dead/live/wind/seismic loads, run a structural analysis, or read displacements, reactions, member forces, modal periods or steel design ratios from a SAP2000 model.
---

# SAP2000

You drive the SAP2000 program open on the user's Windows machine through the `sap2000` MCP tools (`mcp__sap2000__*`). Every change happens in the user's real model, so work carefully and say what you changed.

## Before you start

1. Call `get_model_info`. It attaches to SAP2000 and tells you the file, **units**, lock state and object counts.
   - "Could not find a running SAP2000": ask the user to open SAP2000, or call `connect` with `start_new=true` if they agree.
   - "Could not load the SAP2000 API": the user must run `RegisterSAP2000.exe` from the SAP2000 folder as administrator, with 64-bit Python.
2. If the model has objects and the user asked for a **new** model, confirm before `new_model` or `open_model`: both discard unsaved changes.
3. Choose units once and keep to them. Prefer what the user writes in (kN and m → `kN_m_C`, N and mm → `N_mm_C`, kips and ft → `kip_ft_F`). Every value you send and receive is in the present units. That includes E (kN/m² in `kN_m_C`), unit weight (kN/m³) and line loads (kN/m).

## Workflow

Follow this order. Later steps depend on names created earlier.

1. **Model:** `new_model` with a template when one fits (`2d_frame` portal or braced, `3d_frame`, `grid_only`), otherwise `blank`. Templates create frames and joints for you, so call `list_frames` / `list_points` to learn their names and lengths.
2. **Materials:** `add_material`. Use a code material when the user names one:
   - US steel: region `United States`, standard `ASTM A992`, grade `Grade 50`
   - EU steel: `Europe`, `EN 10025-2`, `S355`
   - EU concrete: `Europe`, `EN 1992-1-1`, `C30/37`
   Otherwise give `e`, `poisson` and `unit_weight` in present units. Typical values in `kN_m_C`: steel E = 2.0e8, ν = 0.3, γ = 76.97; concrete C30 E ≈ 3.3e7, ν = 0.2, γ = 25.
3. **Sections:** `add_frame_section`. Standard steel shapes use `shape="import"`, `import_section="W14X90"` with `import_file="AISC16.xml"`, or `IPE300` / `HE200A` with `Euro.xml`. Shells use `add_shell_section`.
4. **Geometry:** `add_frame` / `add_frames` / `add_area`, then `assign_frame_section` / `assign_area_section`. Coincident joints merge automatically.
5. **Supports:** `set_restraints` with `fixed`, `pinned`, `roller` or explicit `dofs`. An unsupported model makes the analysis fail or give rigid-body motion.
6. **Loads:**
   - `add_load_pattern`. Give exactly one dead pattern `self_weight_multiplier=1`. Each pattern creates a linear static load case with the same name.
   - Frame line loads: `assign_frame_distributed_load`. With `direction="gravity"` a **positive** value acts **downward**. With `x`, `y`, `z` the sign follows the global axes, so downward is negative `z`.
   - Joint loads: `assign_joint_load` uses global signs, so gravity is negative `fz`.
   - Shell pressure: `assign_area_uniform_load`, positive gravity = downward.
7. **Combinations:** `add_load_combination`, for example ULS `1.35·DEAD + 1.5·LIVE` (EN 1990) or `1.2D + 1.6L` (ASCE 7). Ask which code to use if the user hasn't said, or state your assumption.
8. **Save:** `save_model(path=...)` with a full `.sdb` path. Ask where if the model has never been saved. Analysis needs a saved file.
9. **Analyse:** `run_analysis`. Check that every case you need reports `finished`.
10. **Results:** `get_joint_displacements`, `get_joint_reactions`, `get_base_reactions`, `get_frame_forces`, `get_modal_periods`. They accept case or combination names.
11. **Design (steel):** `run_design(kind="steel")`, then `get_steel_design_summary`. A ratio above 1.0 fails.

## Interpreting results

- Frame local axes: axis 1 runs along the member, M3 is major-axis bending, V2 is major shear, P is axial (tension positive).
- Joint displacement U3 is vertical (global Z). Report deflections with units and compare with limits like L/360 or L/250 if the user asks for checks.
- Before reporting, **sanity check**: total vertical base reaction ≈ total applied gravity load (including self weight). For a simply supported beam, check M ≈ wL²/8, and for a fixed-end beam M_end ≈ wL²/12. If numbers are off by an order of magnitude, look for a units mistake before anything else.
- Results tables can be long. Pass `names` for specific objects or lower `limit`, and summarise the max and min values instead of dumping every row.

## Editing after analysis

The model locks after `run_analysis`. Editing it deletes the results, so read everything you need first. Use `unlock_model` explicitly if an edit fails because the model is locked.

## Beyond the built-in tools

- `list_tables` + `get_table` read any SAP2000 interactive database table ("Joint Coordinates", "Element Forces - Frames", "Base Reactions", "Modal Participating Mass Ratios", …).
- `sap_api` calls any `SapModel` OAPI method by path, for example `FrameObj.SetReleases` or `PointObj.SetSpring`. Pass ByRef outputs as placeholders (`0`, `""`, `[]`) in the order the CSi OAPI documentation lists them. A `status` of 0 means success. Explain what a raw call does before running it.
- `refresh_view` redraws SAP2000 so the user sees your changes.

## Reporting back

Finish with a short summary: what you built or changed (with object names), the key results with units, any assumptions (code, combination factors, material values), and where the model is saved.
