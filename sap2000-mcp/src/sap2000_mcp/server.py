"""SAP2000 MCP server: tools that drive SAP2000 through the CSi OAPI."""

from __future__ import annotations

import functools
import math
import os
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

from . import __version__
from .connection import SapConnection, SapError, check
from .enums import (
    COMBO_TYPES, ELM_GROUP, ELM_OBJECT, FRAME_2D_TYPES, FRAME_3D_TYPES, ITEM_GROUP, ITEM_OBJECT,
    LOAD_DIRECTIONS, LOAD_PATTERN_TYPES, MATERIAL_TYPES, RESTRAINT_PRESETS, SHELL_TYPES, UNITS,
    UNITS_BY_ID, lookup,
)

INSTRUCTIONS = """\
Tools for CSi SAP2000 structural analysis. The server drives the SAP2000 program that is open
on this Windows machine.

- All values are in the model's present units. Call get_model_info first to see them, and
  set_units to change them. Units names look like kN_m_C, N_mm_C, kip_ft_F.
- Typical workflow: new_model -> add_material / add_frame_section / add_shell_section ->
  add_frame / add_area -> set_restraints -> add_load_pattern -> assign_* loads ->
  add_load_combination -> save_model -> run_analysis -> get_* results.
- Changing the model after an analysis unlocks it and deletes the results.
- run_analysis needs the model saved to a file first (save_model with a path).
- Pass "ALL" to the `names` of a result tool to get every object.
"""

MAX_ROWS_DEFAULT = 500


def _tool_errors(fn):
    """Turn SAP2000 and input errors into MCP tool errors with a readable message."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except (SapError, ValueError) as exc:
            raise ToolError(str(exc)) from exc

    return wrapper


def _names(model_part: Any) -> list[str]:
    values = check(model_part.GetNameList(0, []), "GetNameList")
    return list(values[1]) if len(values) > 1 and values[1] else []


def _num(v: float) -> float:
    """Round float noise from COM so results stay readable."""
    if isinstance(v, float) and math.isfinite(v):
        return float(f"{v:.6g}")
    return v


def _rows(columns: list[str], arrays: list[Any], limit: int) -> dict[str, Any]:
    n = min((len(a) for a in arrays), default=0)
    rows = [
        {c: (_num(a[i]) if isinstance(a[i], float) else a[i]) for c, a in zip(columns, arrays)}
        for i in range(min(n, limit))
    ]
    out: dict[str, Any] = {"count": n, "rows": rows}
    if n > limit:
        out["truncated"] = f"Showing {limit} of {n} rows. Raise `limit` or filter by name."
    return out


class ComboItem(BaseModel):
    name: str = Field(description="Load case or load combination name")
    scale: float = Field(1.0, description="Scale factor")
    is_combo: bool = Field(False, description="True if `name` is another combination")


class Point3D(BaseModel):
    x: float
    y: float
    z: float


def create_server(conn: SapConnection | None = None) -> MCPServer:
    conn = conn or SapConnection()
    mcp = MCPServer(
        "sap2000",
        title="SAP2000",
        version=__version__,
        instructions=INSTRUCTIONS,
        website_url="https://github.com/C-Kajanan/C-Kajanan/tree/main/sap2000-mcp",
    )

    def tool(fn):
        return mcp.tool()(_tool_errors(fn))

    # ------------------------------------------------------------------ session

    @tool
    async def connect(start_new: bool = False, program_path: str | None = None) -> dict:
        """Attach to the running SAP2000. With start_new=true, start SAP2000 if none is open.

        program_path: full path to SAP2000.exe, only needed for a non-default install.
        """

        def go(c: SapConnection) -> dict:
            c.detach()
            c.attach(start_if_missing=start_new, program_path=program_path)
            return {"connected": True, "started_new_instance": c.started_by_us, **_info(c.model())}

        return await conn.run_raw(go)

    @tool
    async def disconnect(close_program: bool = False, save: bool = False) -> dict:
        """Release SAP2000. close_program=true also exits SAP2000 (save=true saves first)."""
        await conn.run_raw(lambda c: c.detach(close_program=close_program, save=save))
        return {"connected": False}

    def _info(m: Any) -> dict:
        units = m.GetPresentUnits()
        return {
            "sap2000_version": check(m.GetVersion("", 0.0), "GetVersion")[0],
            "file": m.GetModelFilename(True) or None,
            "units": UNITS_BY_ID.get(units, units),
            "locked": bool(m.GetModelIsLocked()),
            "counts": {
                "points": m.PointObj.Count(),
                "frames": m.FrameObj.Count(),
                "areas": m.AreaObj.Count(),
                "load_patterns": m.LoadPatterns.Count(),
                "load_cases": m.LoadCases.Count(),
                "combinations": m.RespCombo.Count(),
            },
        }

    @tool
    async def get_model_info() -> dict:
        """SAP2000 version, file path, present units, lock state and object counts."""
        return await conn.run(_info)

    @tool
    async def set_units(units: str) -> dict:
        """Set the present units, e.g. kN_m_C, N_mm_C, kip_in_F, kip_ft_F."""
        code = lookup(UNITS, units, "units")
        await conn.run(lambda m: check(m.SetPresentUnits(code), "SetPresentUnits"))
        return {"units": UNITS_BY_ID[code]}

    @tool
    async def new_model(
        template: Literal["blank", "grid_only", "2d_frame", "3d_frame"] = "blank",
        units: str = "kN_m_C",
        stories: int = 3,
        story_height: float = 3.0,
        bays_x: int = 3,
        bay_width_x: float = 6.0,
        bays_y: int = 3,
        bay_width_y: float = 6.0,
        frame_type: str | None = None,
        restrain_base: bool = True,
        beam_section: str = "Default",
        column_section: str = "Default",
    ) -> dict:
        """Start a new model. This discards the current model without saving it.

        template: blank, grid_only, 2d_frame (portal | concentric_braced | eccentric_braced)
        or 3d_frame (open_frame | perimeter_frame | beam_slab | flat_plate). Set the frame
        variant with frame_type. Dimensions are in `units`.
        """
        u = lookup(UNITS, units, "units")

        def go(m: Any) -> dict:
            check(m.InitializeNewModel(u), "InitializeNewModel")
            f = m.File
            if template == "blank":
                check(f.NewBlank(), "NewBlank")
            elif template == "grid_only":
                check(
                    f.NewGridOnly(stories, story_height, story_height, bays_x + 1, bays_y + 1, bay_width_x, bay_width_y),
                    "NewGridOnly",
                )
            elif template == "2d_frame":
                t = lookup(FRAME_2D_TYPES, frame_type or "portal", "2D frame type")
                check(
                    f.New2DFrame(t, stories, story_height, bays_x, bay_width_x, restrain_base,
                                 beam_section, column_section, "Default"),
                    "New2DFrame",
                )
            else:
                t = lookup(FRAME_3D_TYPES, frame_type or "open_frame", "3D frame type")
                check(
                    f.New3DFrame(t, stories, story_height, bays_x, bay_width_x, bays_y, bay_width_y,
                                 restrain_base, beam_section, column_section, "Default", 4, 4),
                    "New3DFrame",
                )
            return _info(m)

        return await conn.run(go)

    @tool
    async def open_model(path: str) -> dict:
        """Open a .sdb (or .s2k/.$2k/.xlsx/.mdb) model file."""
        def go(m: Any) -> dict:
            check(m.File.OpenFile(path), f"OpenFile {path}")
            return _info(m)

        return await conn.run(go)

    @tool
    async def save_model(path: str | None = None) -> dict:
        """Save the model. Give a full .sdb path the first time, or to save a copy."""
        def go(m: Any) -> dict:
            target = path or m.GetModelFilename(True)
            if not target:
                raise SapError("The model has never been saved. Pass a full path ending in .sdb.")
            if path:
                folder = os.path.dirname(os.path.abspath(path))
                if folder and not os.path.isdir(folder):
                    os.makedirs(folder, exist_ok=True)
            check(m.File.Save(target), f"Save {target}")
            return {"saved": target}

        return await conn.run(go)

    @tool
    async def refresh_view() -> dict:
        """Redraw the SAP2000 windows so changes made through the API show up."""
        await conn.run(lambda m: check(m.View.RefreshView(0, False), "RefreshView"))
        return {"refreshed": True}

    # --------------------------------------------------------------- geometry

    @tool
    async def add_point(x: float, y: float, z: float, name: str = "") -> dict:
        """Add a joint at global coordinates. Returns its name."""
        out = await conn.run(lambda m: check(m.PointObj.AddCartesian(x, y, z, "", name, "Global"), "AddCartesian"))
        return {"name": out[0]}

    @tool
    async def add_frame(
        section: str = "Default",
        xi: float | None = None, yi: float | None = None, zi: float | None = None,
        xj: float | None = None, yj: float | None = None, zj: float | None = None,
        point_i: str | None = None, point_j: str | None = None,
        name: str = "",
    ) -> dict:
        """Add a frame (beam, column, brace) by end coordinates or by two existing joint names."""
        def go(m: Any) -> list:
            if point_i and point_j:
                return check(m.FrameObj.AddByPoint(point_i, point_j, "", section, name), "FrameObj.AddByPoint")
            coords = [xi, yi, zi, xj, yj, zj]
            if any(c is None for c in coords):
                raise ValueError("Give all of xi, yi, zi, xj, yj, zj, or both point_i and point_j.")
            return check(m.FrameObj.AddByCoord(*coords, "", section, name, "Global"), "FrameObj.AddByCoord")

        out = await conn.run(go)
        return {"name": out[0], "section": section}

    @tool
    async def add_frames(frames: list[list[float]], section: str = "Default") -> dict:
        """Add many frames at once. Each item is [xi, yi, zi, xj, yj, zj]."""
        def go(m: Any) -> list[str]:
            names = []
            for f in frames:
                if len(f) != 6:
                    raise ValueError(f"Each frame needs 6 numbers, got {f}")
                names.append(check(m.FrameObj.AddByCoord(*f, "", section, "", "Global"), "FrameObj.AddByCoord")[0])
            return names

        names = await conn.run(go)
        return {"count": len(names), "names": names, "section": section}

    @tool
    async def add_area(points: list[Point3D], section: str = "Default", name: str = "") -> dict:
        """Add a shell/area object from 3 or more corner points [{x,y,z}, ...] in order."""
        if len(points) < 3:
            raise ValueError("An area needs at least 3 points.")
        xs = [p.x for p in points]
        ys = [p.y for p in points]
        zs = [p.z for p in points]
        out = await conn.run(
            lambda m: check(m.AreaObj.AddByCoord(len(points), xs, ys, zs, "", section, name, "Global"), "AreaObj.AddByCoord")
        )
        return {"name": out[-1], "section": section}

    @tool
    async def list_points(limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Joints with coordinates and restraints (U1 U2 U3 R1 R2 R3)."""
        def go(m: Any) -> dict:
            names = _names(m.PointObj)
            rows = []
            for n in names[:limit]:
                x, y, z = check(m.PointObj.GetCoordCartesian(n, 0.0, 0.0, 0.0, "Global"), "GetCoordCartesian")[:3]
                r = check(m.PointObj.GetRestraint(n, []), "GetRestraint")[0]
                rows.append({"name": n, "x": _num(x), "y": _num(y), "z": _num(z),
                             "restraint": "".join("1" if b else "0" for b in r)})
            out: dict[str, Any] = {"count": len(names), "rows": rows}
            if len(names) > limit:
                out["truncated"] = f"Showing {limit} of {len(names)}"
            return out

        return await conn.run(go)

    @tool
    async def list_frames(limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Frames with end joints, section and length."""
        def go(m: Any) -> dict:
            names = _names(m.FrameObj)
            rows = []
            for n in names[:limit]:
                pi, pj = check(m.FrameObj.GetPoints(n, "", ""), "GetPoints")[:2]
                sec = check(m.FrameObj.GetSection(n, "", ""), "GetSection")[0]
                a = check(m.PointObj.GetCoordCartesian(pi, 0.0, 0.0, 0.0, "Global"), "GetCoordCartesian")[:3]
                b = check(m.PointObj.GetCoordCartesian(pj, 0.0, 0.0, 0.0, "Global"), "GetCoordCartesian")[:3]
                rows.append({"name": n, "point_i": pi, "point_j": pj, "section": sec,
                             "length": _num(math.dist(a, b))})
            out: dict[str, Any] = {"count": len(names), "rows": rows}
            if len(names) > limit:
                out["truncated"] = f"Showing {limit} of {len(names)}"
            return out

        return await conn.run(go)

    @tool
    async def list_areas(limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Area objects with their corner joints and section."""
        def go(m: Any) -> dict:
            names = _names(m.AreaObj)
            rows = []
            for n in names[:limit]:
                pts = check(m.AreaObj.GetPoints(n, 0, []), "AreaObj.GetPoints")
                sec = check(m.AreaObj.GetProperty(n, ""), "AreaObj.GetProperty")[0]
                rows.append({"name": n, "points": list(pts[1]), "section": sec})
            out: dict[str, Any] = {"count": len(names), "rows": rows}
            if len(names) > limit:
                out["truncated"] = f"Showing {limit} of {len(names)}"
            return out

        return await conn.run(go)

    @tool
    async def delete_objects(kind: Literal["frame", "area"], names: list[str]) -> dict:
        """Delete frames or areas by name. Use ["ALL"] to delete every object of that kind."""
        def go(m: Any) -> int:
            obj = m.FrameObj if kind == "frame" else m.AreaObj
            if [n.upper() for n in names] == ["ALL"]:
                count = obj.Count()
                check(obj.Delete("ALL", ITEM_GROUP), f"Delete all {kind}s")
                return count
            for n in names:
                check(obj.Delete(n, ITEM_OBJECT), f"Delete {kind} {n}")
            return len(names)

        return {"deleted": await conn.run(go), "kind": kind}

    @tool
    async def set_restraints(
        points: list[str],
        preset: Literal["fixed", "pinned", "roller", "free"] | None = "fixed",
        dofs: list[bool] | None = None,
    ) -> dict:
        """Support joints. Use a preset or `dofs` = [U1, U2, U3, R1, R2, R3] booleans."""
        r = list(dofs) if dofs is not None else RESTRAINT_PRESETS[preset or "fixed"]
        if len(r) != 6:
            raise ValueError("dofs needs 6 booleans: U1, U2, U3, R1, R2, R3")

        def go(m: Any) -> None:
            for p in points:
                check(m.PointObj.SetRestraint(p, r, ITEM_OBJECT), f"SetRestraint {p}")

        await conn.run(go)
        return {"points": points, "restraint": "".join("1" if b else "0" for b in r)}

    @tool
    async def get_selection() -> dict:
        """Objects the user has selected in SAP2000, grouped by type."""
        kinds = {1: "point", 2: "frame", 3: "cable", 4: "tendon", 5: "area", 6: "solid", 7: "link"}

        def go(m: Any) -> dict:
            n, types, names = check(m.SelectObj.GetSelected(0, [], []), "GetSelected")[:3]
            grouped: dict[str, list[str]] = {}
            for t, name in zip(types or [], names or []):
                grouped.setdefault(kinds.get(t, str(t)), []).append(name)
            return {"count": n, "selected": grouped}

        return await conn.run(go)

    # -------------------------------------------------------------- properties

    @tool
    async def add_material(
        name: str,
        material_type: str = "steel",
        e: float | None = None,
        poisson: float | None = None,
        thermal_coeff: float = 1.17e-5,
        unit_weight: float | None = None,
        region: str | None = None,
        standard: str | None = None,
        grade: str | None = None,
    ) -> dict:
        """Add or update a material.

        Either give region/standard/grade to load a code material (for example
        "United States", "ASTM A992", "Grade 50" or "Europe", "EN 1992-1-1", "C30/37"),
        or give e (modulus) and poisson for an isotropic material in present units.
        material_type: steel, concrete, aluminum, coldformed, rebar, tendon, nodesign.
        """
        t = lookup(MATERIAL_TYPES, material_type, "material type")

        def go(m: Any) -> str:
            pm = m.PropMaterial
            if region and standard and grade:
                out = check(pm.AddMaterial("", t, region, standard, grade, name), "AddMaterial")
                created = out[0] or name
            else:
                if e is None or poisson is None:
                    raise ValueError("Give e and poisson, or region, standard and grade.")
                check(pm.SetMaterial(name, t), "SetMaterial")
                check(pm.SetMPIsotropic(name, e, poisson, thermal_coeff), "SetMPIsotropic")
                created = name
            if unit_weight is not None:
                check(pm.SetWeightAndMass(created, 1, unit_weight), "SetWeightAndMass")
            return created

        return {"name": await conn.run(go), "type": material_type}

    @tool
    async def list_materials() -> dict:
        """Material property names."""
        return {"names": await conn.run(lambda m: _names(m.PropMaterial))}

    @tool
    async def add_frame_section(
        name: str,
        material: str,
        shape: Literal["rectangle", "circle", "pipe", "tube", "i_section", "import"],
        depth: float | None = None,
        width: float | None = None,
        flange_thickness: float | None = None,
        web_thickness: float | None = None,
        diameter: float | None = None,
        wall_thickness: float | None = None,
        import_file: str = "AISC16.xml",
        import_section: str | None = None,
    ) -> dict:
        """Define a frame section.

        rectangle: depth, width. circle: diameter. pipe: diameter, wall_thickness.
        tube: depth, width, flange_thickness, web_thickness.
        i_section: depth, width, flange_thickness, web_thickness.
        import: import_section from a CSi section file (import_file, e.g. AISC16.xml,
        Euro.xml, BSShapes2006.xml), for example import_section="W14X90".
        """
        def need(**vals: float | None) -> None:
            missing = [k for k, v in vals.items() if v is None]
            if missing:
                raise ValueError(f"{shape} needs: {', '.join(missing)}")

        def go(m: Any) -> None:
            pf = m.PropFrame
            if shape == "rectangle":
                need(depth=depth, width=width)
                check(pf.SetRectangle(name, material, depth, width), "SetRectangle")
            elif shape == "circle":
                need(diameter=diameter)
                check(pf.SetCircle(name, material, diameter), "SetCircle")
            elif shape == "pipe":
                need(diameter=diameter, wall_thickness=wall_thickness)
                check(pf.SetPipe(name, material, diameter, wall_thickness), "SetPipe")
            elif shape == "tube":
                need(depth=depth, width=width, flange_thickness=flange_thickness, web_thickness=web_thickness)
                check(pf.SetTube(name, material, depth, width, flange_thickness, web_thickness), "SetTube")
            elif shape == "i_section":
                need(depth=depth, width=width, flange_thickness=flange_thickness, web_thickness=web_thickness)
                check(pf.SetISection(name, material, depth, width, flange_thickness, web_thickness,
                                     width, flange_thickness), "SetISection")
            else:
                need(import_section=import_section)  # type: ignore[arg-type]
                check(pf.ImportProp(name, material, import_file, import_section), "ImportProp")

        await conn.run(go)
        return {"name": name, "shape": shape, "material": material}

    @tool
    async def list_frame_sections() -> dict:
        """Frame section property names."""
        return {"names": await conn.run(lambda m: _names(m.PropFrame))}

    @tool
    async def add_shell_section(
        name: str,
        material: str,
        thickness: float,
        shell_type: str = "shell_thin",
        bending_thickness: float | None = None,
    ) -> dict:
        """Define a shell/area section. shell_type: shell_thin, shell_thick, plate_thin, plate_thick, membrane."""
        t = lookup(SHELL_TYPES, shell_type, "shell type")
        bend = bending_thickness if bending_thickness is not None else thickness
        await conn.run(
            lambda m: check(m.PropArea.SetShell_1(name, t, False, material, 0.0, thickness, bend), "SetShell_1")
        )
        return {"name": name, "shell_type": shell_type, "thickness": thickness}

    @tool
    async def list_area_sections() -> dict:
        """Area (shell) section property names."""
        return {"names": await conn.run(lambda m: _names(m.PropArea))}

    @tool
    async def assign_frame_section(frames: list[str], section: str) -> dict:
        """Assign a frame section to frames. Use ["ALL"] for every frame."""
        def go(m: Any) -> None:
            if [f.upper() for f in frames] == ["ALL"]:
                check(m.FrameObj.SetSection("ALL", section, ITEM_GROUP), "SetSection")
            else:
                for f in frames:
                    check(m.FrameObj.SetSection(f, section, ITEM_OBJECT), f"SetSection {f}")

        await conn.run(go)
        return {"frames": frames, "section": section}

    @tool
    async def assign_area_section(areas: list[str], section: str) -> dict:
        """Assign a shell section to areas. Use ["ALL"] for every area."""
        def go(m: Any) -> None:
            if [a.upper() for a in areas] == ["ALL"]:
                check(m.AreaObj.SetProperty("ALL", section, ITEM_GROUP), "SetProperty")
            else:
                for a in areas:
                    check(m.AreaObj.SetProperty(a, section, ITEM_OBJECT), f"SetProperty {a}")

        await conn.run(go)
        return {"areas": areas, "section": section}

    # ------------------------------------------------------------------- loads

    @tool
    async def add_load_pattern(name: str, pattern_type: str = "dead", self_weight_multiplier: float = 0.0) -> dict:
        """Add a load pattern (and its linear static load case).

        pattern_type: dead, superdead, live, reducelive, quake, wind, snow, other,
        temperature, rooflive, notional. Use self_weight_multiplier=1 on one dead pattern.
        """
        t = lookup(LOAD_PATTERN_TYPES, pattern_type, "load pattern type")
        await conn.run(lambda m: check(m.LoadPatterns.Add(name, t, self_weight_multiplier, True), "LoadPatterns.Add"))
        return {"name": name, "type": pattern_type, "self_weight_multiplier": self_weight_multiplier}

    @tool
    async def list_loads() -> dict:
        """Load patterns, load cases and load combinations in the model."""
        def go(m: Any) -> dict:
            return {
                "load_patterns": _names(m.LoadPatterns),
                "load_cases": _names(m.LoadCases),
                "combinations": _names(m.RespCombo),
            }

        return await conn.run(go)

    @tool
    async def assign_joint_load(
        points: list[str], pattern: str,
        fx: float = 0, fy: float = 0, fz: float = 0, mx: float = 0, my: float = 0, mz: float = 0,
        replace: bool = False,
    ) -> dict:
        """Apply forces/moments to joints in global axes. Gravity is negative fz."""
        values = [fx, fy, fz, mx, my, mz]

        def go(m: Any) -> None:
            for p in points:
                check(m.PointObj.SetLoadForce(p, pattern, values, replace, "Global", ITEM_OBJECT), f"SetLoadForce {p}")

        await conn.run(go)
        return {"points": points, "pattern": pattern, "load": values}

    @tool
    async def assign_frame_distributed_load(
        frames: list[str], pattern: str, value: float,
        value_end: float | None = None,
        direction: str = "gravity",
        start: float = 0.0, end: float = 1.0, relative: bool = True,
        load_type: Literal["force", "moment"] = "force",
        replace: bool = True,
    ) -> dict:
        """Apply a uniform or trapezoidal line load to frames (force/length).

        direction: gravity (downward, give a positive value), x, y, z, local_1/2/3,
        x_proj, y_proj, z_proj, gravity_proj. start/end are relative (0..1) unless
        relative=false. Use frames=["ALL"] for every frame.
        """
        d = lookup(LOAD_DIRECTIONS, direction, "direction")
        v2 = value if value_end is None else value_end
        kind = 1 if load_type == "force" else 2

        def go(m: Any) -> None:
            targets = [("ALL", ITEM_GROUP)] if [f.upper() for f in frames] == ["ALL"] else [(f, ITEM_OBJECT) for f in frames]
            for f, item in targets:
                check(
                    m.FrameObj.SetLoadDistributed(f, pattern, kind, d, start, end, value, v2, "Global", relative, replace, item),
                    f"SetLoadDistributed {f}",
                )

        await conn.run(go)
        return {"frames": frames, "pattern": pattern, "value": value, "value_end": v2, "direction": direction}

    @tool
    async def assign_frame_point_load(
        frames: list[str], pattern: str, value: float, distance: float = 0.5,
        direction: str = "gravity", relative: bool = True,
        load_type: Literal["force", "moment"] = "force", replace: bool = False,
    ) -> dict:
        """Apply a concentrated load on frames at `distance` (relative 0..1 by default)."""
        d = lookup(LOAD_DIRECTIONS, direction, "direction")
        kind = 1 if load_type == "force" else 2

        def go(m: Any) -> None:
            for f in frames:
                check(
                    m.FrameObj.SetLoadPoint(f, pattern, kind, d, distance, value, "Global", relative, replace, ITEM_OBJECT),
                    f"SetLoadPoint {f}",
                )

        await conn.run(go)
        return {"frames": frames, "pattern": pattern, "value": value, "distance": distance}

    @tool
    async def assign_area_uniform_load(
        areas: list[str], pattern: str, value: float, direction: str = "gravity", replace: bool = True,
    ) -> dict:
        """Apply a uniform pressure (force/area) to areas. Use areas=["ALL"] for every area."""
        d = lookup(LOAD_DIRECTIONS, direction, "direction")

        def go(m: Any) -> None:
            targets = [("ALL", ITEM_GROUP)] if [a.upper() for a in areas] == ["ALL"] else [(a, ITEM_OBJECT) for a in areas]
            for a, item in targets:
                check(m.AreaObj.SetLoadUniform(a, pattern, value, d, replace, "Global", item), f"SetLoadUniform {a}")

        await conn.run(go)
        return {"areas": areas, "pattern": pattern, "value": value, "direction": direction}

    @tool
    async def add_load_combination(name: str, items: list[ComboItem], combo_type: str = "linear_add") -> dict:
        """Create a load combination, e.g. items=[{name:"DEAD",scale:1.2},{name:"LIVE",scale:1.6}].

        combo_type: linear_add, envelope, absolute_add, srss, range_add.
        """
        t = lookup(COMBO_TYPES, combo_type, "combination type")

        def go(m: Any) -> None:
            check(m.RespCombo.Add(name, t), "RespCombo.Add")
            for it in items:
                check(m.RespCombo.SetCaseList(name, 1 if it.is_combo else 0, it.name, it.scale), f"SetCaseList {it.name}")

        await conn.run(go)
        return {"name": name, "type": combo_type, "items": [i.model_dump() for i in items]}

    # ---------------------------------------------------------------- analysis

    @tool
    async def run_analysis(cases: list[str] | None = None) -> dict:
        """Run the analysis. cases: load cases to run (default: all). The model must be saved first."""
        def go(m: Any) -> dict:
            if not m.GetModelFilename(True):
                raise SapError("Save the model with save_model(path=...) before running the analysis.")
            a = m.Analyze
            if cases:
                check(a.SetRunCaseFlag("", False, True), "SetRunCaseFlag")
                for c in cases:
                    check(a.SetRunCaseFlag(c, True, False), f"SetRunCaseFlag {c}")
            else:
                check(a.SetRunCaseFlag("", True, True), "SetRunCaseFlag")
            check(a.RunAnalysis(), "RunAnalysis")
            status = check(a.GetCaseStatus(0, [], []), "GetCaseStatus")
            labels = {1: "not run", 2: "could not start", 3: "not finished", 4: "finished"}
            return {
                "cases": {n: labels.get(s, s) for n, s in zip(status[1] or [], status[2] or [])},
            }

        return await conn.run(go)

    @tool
    async def unlock_model() -> dict:
        """Unlock the model after an analysis so it can be edited. This deletes the results."""
        await conn.run(lambda m: check(m.SetModelIsLocked(False), "SetModelIsLocked"))
        return {"locked": False}

    def _select_output(m: Any, case_or_combo: list[str]) -> None:
        setup = m.Results.Setup
        check(setup.DeselectAllCasesAndCombosForOutput(), "DeselectAllCasesAndCombosForOutput")
        combos = {c.upper() for c in _names(m.RespCombo)}
        for name in case_or_combo:
            if name.upper() in combos:
                check(setup.SetComboSelectedForOutput(name, True), f"Select combo {name}")
            else:
                check(setup.SetCaseSelectedForOutput(name, True), f"Select case {name}")

    def _targets(names: list[str]) -> list[tuple[str, int]]:
        if not names or [n.upper() for n in names] == ["ALL"]:
            return [("ALL", ELM_GROUP)]
        return [(n, ELM_OBJECT) for n in names]

    def _joint_results(method: str, labels: list[str]):
        async def run(names: list[str], cases: list[str], limit: int) -> dict:
            def go(m: Any) -> dict:
                _select_output(m, cases)
                cols: list[list[Any]] = [[] for _ in range(4 + len(labels))]
                for n, item in _targets(names):
                    fn = getattr(m.Results, method)
                    out = check(fn(n, item, 0, [], [], [], [], [], *([[]] * len(labels))), method)
                    # out = [count, obj, elm, case, step_type, step_num, values...]
                    for col, arr in zip(cols, [out[1], out[3], out[4], out[5], *out[6:6 + len(labels)]]):
                        col.extend(arr or [])
                return _rows(["joint", "case", "step_type", "step", *labels], cols, limit)

            return await conn.run(go)

        return run

    _displ = _joint_results("JointDispl", ["U1", "U2", "U3", "R1", "R2", "R3"])
    _react = _joint_results("JointReact", ["F1", "F2", "F3", "M1", "M2", "M3"])

    @tool
    async def get_joint_displacements(cases: list[str], names: list[str] | None = None, limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Joint displacements (U1-U3, R1-R3) for load cases or combinations. names default to ALL."""
        return await _displ(names or ["ALL"], cases, limit)

    @tool
    async def get_joint_reactions(cases: list[str], names: list[str] | None = None, limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Support reactions (F1-F3, M1-M3) for load cases or combinations. names default to ALL."""
        return await _react(names or ["ALL"], cases, limit)

    @tool
    async def get_base_reactions(cases: list[str]) -> dict:
        """Total base reactions (FX FY FZ MX MY MZ) for load cases or combinations."""
        def go(m: Any) -> dict:
            _select_output(m, cases)
            out = check(m.Results.BaseReact(0, [], [], [], [], [], [], [], [], [], 0.0, 0.0, 0.0), "BaseReact")
            labels = ["FX", "FY", "FZ", "MX", "MY", "MZ"]
            return _rows(["case", "step_type", "step", *labels], [out[1], out[2], out[3], *out[4:10]], 10_000)

        return await conn.run(go)

    @tool
    async def get_frame_forces(cases: list[str], names: list[str] | None = None, limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Frame internal forces along each member (P, V2, V3, T, M2, M3) at output stations."""
        labels = ["P", "V2", "V3", "T", "M2", "M3"]

        def go(m: Any) -> dict:
            _select_output(m, cases)
            cols: list[list[Any]] = [[] for _ in range(5 + len(labels))]
            for n, item in _targets(names or ["ALL"]):
                out = check(
                    m.Results.FrameForce(n, item, 0, [], [], [], [], [], [], [], [], [], [], [], [], [], []),
                    "FrameForce",
                )
                # [count, obj, obj_sta, elm, elm_sta, case, step_type, step_num, P..M3]
                for col, arr in zip(cols, [out[1], out[2], out[5], out[6], out[7], *out[8:14]]):
                    col.extend(arr or [])
            return _rows(["frame", "station", "case", "step_type", "step", *labels], cols, limit)

        return await conn.run(go)

    @tool
    async def get_modal_periods(case: str = "MODAL") -> dict:
        """Modal periods and frequencies for a modal load case."""
        def go(m: Any) -> dict:
            _select_output(m, [case])
            out = check(m.Results.ModalPeriod(0, [], [], [], [], [], [], []), "ModalPeriod")
            return _rows(["case", "step_type", "mode", "period", "frequency", "circular_frequency", "eigenvalue"],
                         [out[1], out[2], out[3], out[4], out[5], out[6], out[7]], 10_000)

        return await conn.run(go)

    # ------------------------------------------------------------------ design

    @tool
    async def run_design(kind: Literal["steel", "concrete"] = "steel") -> dict:
        """Run steel or concrete frame design. Needs a completed analysis."""
        def go(m: Any) -> None:
            d = m.DesignSteel if kind == "steel" else m.DesignConcrete
            check(d.StartDesign(), f"{kind} StartDesign")

        await conn.run(go)
        return {"design": kind, "done": True}

    @tool
    async def get_steel_design_summary(frames: list[str] | None = None, limit: int = MAX_ROWS_DEFAULT) -> dict:
        """Steel design ratios per frame (after run_design). Sorted by ratio, highest first."""
        def go(m: Any) -> dict:
            cols: list[list[Any]] = [[] for _ in range(6)]
            targets = [("ALL", ITEM_GROUP)] if not frames or [f.upper() for f in frames] == ["ALL"] else [(f, ITEM_OBJECT) for f in frames]
            for n, item in targets:
                out = check(
                    m.DesignSteel.GetSummaryResults(n, 0, [], [], [], [], [], [], [], item),
                    "DesignSteel.GetSummaryResults",
                )
                # [count, frame, ratio, ratio_type, location, combo, errors, warnings]
                for col, arr in zip(cols, [out[1], out[2], out[5], out[4], out[6], out[7]]):
                    col.extend(arr or [])
            order = sorted(range(len(cols[0])), key=lambda i: -(cols[1][i] or 0))
            cols = [[c[i] for i in order] for c in cols]
            return _rows(["frame", "ratio", "combo", "location", "errors", "warnings"], cols, limit)

        return await conn.run(go)

    # ------------------------------------------------------------ data tables

    @tool
    async def list_tables(filter: str | None = None, only_with_data: bool = True) -> dict:
        """Interactive database table keys (e.g. "Joint Coordinates", "Element Forces - Frames")."""
        def go(m: Any) -> dict:
            dt = m.DatabaseTables
            out = check(
                dt.GetAvailableTables(0, [], [], []) if only_with_data else dt.GetAllTables(0, [], [], [], []),
                "GetAvailableTables",
            )
            keys = list(out[1] or [])
            if filter:
                keys = [k for k in keys if filter.lower() in k.lower()]
            return {"count": len(keys), "tables": keys}

        return await conn.run(go)

    @tool
    async def get_table(table: str, group: str = "All", limit: int = 200) -> dict:
        """Read an interactive database table, e.g. "Joint Coordinates" or "Base Reactions".

        For result tables, select the cases first: they use the cases chosen by the
        last get_* result tool, or call one with the cases you want.
        """
        def go(m: Any) -> dict:
            out = check(m.DatabaseTables.GetTableForDisplayArray(table, [], group, 0, [], 0, []), f"GetTableForDisplayArray {table}")
            # Trailing values are: version, fields, record count, flat data.
            fields, count, data = list(out[-3] or []), int(out[-2]), list(out[-1] or [])
            width = len(fields) or 1
            rows = [dict(zip(fields, data[i * width:(i + 1) * width])) for i in range(min(count, limit))]
            result: dict[str, Any] = {"table": table, "fields": fields, "count": count, "rows": rows}
            if count > limit:
                result["truncated"] = f"Showing {limit} of {count} rows"
            return result

        return await conn.run(go)

    # ---------------------------------------------------------------- escape

    @tool
    async def sap_api(path: str, args: list[Any] | None = None) -> dict:
        """Call any SapModel OAPI method directly, for things the other tools don't cover.

        path is relative to SapModel, e.g. "FrameObj.SetReleases" or "GetProjectInfo".
        args are positional, with placeholders (0, "", []) for ByRef outputs, as in the
        CSi OAPI documentation. Returns the outputs and the status code.
        """
        parts = [p for p in path.split(".") if p]
        if not parts or any(p.startswith("_") for p in parts):
            raise ValueError("path must look like 'FrameObj.GetSection'")

        def go(m: Any) -> dict:
            target = m
            for p in parts:
                target = getattr(target, p)
            result = target(*(args or [])) if callable(target) else target
            if isinstance(result, (list, tuple)) and result and isinstance(result[-1], int):
                return {"outputs": _plain(list(result[:-1])), "status": result[-1], "ok": result[-1] == 0}
            return {"result": _plain(result)}

        return await conn.run(go)

    return mcp


def _plain(v: Any) -> Any:
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return _num(v) if isinstance(v, float) else v
    return str(v)
