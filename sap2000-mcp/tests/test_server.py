"""End-to-end tests over the MCP protocol against a fake SAP2000."""

from __future__ import annotations

import asyncio
import json

import pytest
from mcp.client import Client

from fake_sap import SapObject
from sap2000_mcp.connection import SapConnection, SapError, check
from sap2000_mcp.server import create_server


def run(coro):
    return asyncio.run(coro)


class Harness:
    def __init__(self) -> None:
        self.sap = SapObject()
        self.server = create_server(SapConnection(factory=lambda: self.sap))

    @property
    def model(self):
        return self.sap.SapModel

    async def call(self, _tool: str, /, **args):
        async with Client(self.server) as client:
            result = await client.call_tool(_tool, args)
        text = result.content[0].text
        assert not result.is_error, f"{_tool} failed: {text}"
        return json.loads(text)

    async def fail(self, _tool: str, /, **args) -> str:
        async with Client(self.server) as client:
            result = await client.call_tool(_tool, args)
        assert result.is_error, result
        return result.content[0].text


@pytest.fixture
def h() -> Harness:
    return Harness()


def test_check_normalises_return_values():
    assert check(0, "x") == []
    assert check(["A", 0], "x") == ["A"]
    with pytest.raises(SapError, match="returned 1"):
        check(["A", 1], "AddByCoord")


def test_lists_tools(h):
    async def go():
        async with Client(h.server) as client:
            tools = (await client.list_tools()).tools
        return {t.name for t in tools}

    names = run(go())
    for expected in [
        "connect", "get_model_info", "new_model", "add_frame", "add_area", "set_restraints",
        "add_load_pattern", "assign_frame_distributed_load", "add_load_combination",
        "run_analysis", "get_joint_displacements", "get_frame_forces", "get_table", "sap_api",
    ]:
        assert expected in names


def test_model_info(h):
    info = run(h.call("get_model_info"))
    assert info["units"] == "kN_m_C"
    assert info["sap2000_version"] == "26.0.0"
    assert info["counts"]["points"] == 0


def test_portal_frame_workflow(h):
    async def go():
        await h.call("new_model", template="2d_frame", units="kN_m_C", stories=1, bays_x=1, story_height=3, bay_width_x=6)
        await h.call("add_material", name="S355", material_type="steel", e=2.1e8, poisson=0.3, unit_weight=77)
        await h.call("add_frame_section", name="R300x500", material="S355", shape="rectangle", depth=0.5, width=0.3)
        await h.call("assign_frame_section", frames=["ALL"], section="R300x500")
        frames = await h.call("list_frames")
        await h.call("add_load_pattern", name="DEAD", pattern_type="dead", self_weight_multiplier=1)
        await h.call("add_load_pattern", name="LIVE", pattern_type="live")
        beam = [r for r in frames["rows"] if r["length"] == 6][0]["name"]
        await h.call("assign_frame_distributed_load", frames=[beam], pattern="LIVE", value=10)
        await h.call("add_load_combination", name="ULS", items=[{"name": "DEAD", "scale": 1.35}, {"name": "LIVE", "scale": 1.5}])
        await h.call("save_model", path="/tmp/sap2000-mcp-test/portal.sdb")
        status = await h.call("run_analysis")
        displ = await h.call("get_joint_displacements", cases=["ULS"])
        reactions = await h.call("get_joint_reactions", cases=["DEAD"])
        forces = await h.call("get_frame_forces", cases=["LIVE"], names=[beam])
        return frames, beam, status, displ, reactions, forces

    frames, beam, status, displ, reactions, forces = run(go())
    assert frames["count"] == 3
    assert {r["section"] for r in frames["rows"]} == {"R300x500"}
    m = h.model
    assert m.FrameObj.items[beam]["loads"] == [("dist", "LIVE", 10, 10, 10)]
    assert m.RespCombo.items["ULS"]["cases"] == [(0, "DEAD", 1.35), (0, "LIVE", 1.5)]
    assert m.LoadPatterns.items["DEAD"]["sw"] == 1
    assert status["cases"]["DEAD"] == "finished"
    assert displ["count"] == 4 and displ["rows"][0]["case"] == "ULS"
    assert m.Results.Setup.selected == [("case", "LIVE")]
    assert reactions["count"] == 2 and reactions["rows"][0]["F3"] == 50
    assert forces["count"] == 3 and forces["rows"][1]["M3"] == 12.5


def test_combo_is_selected_as_combo(h):
    async def go():
        await h.call("add_load_pattern", name="DEAD")
        await h.call("add_load_combination", name="C1", items=[{"name": "DEAD", "scale": 1.0}])
        await h.call("get_base_reactions", cases=["C1", "DEAD"])

    run(go())
    assert h.model.Results.Setup.selected == [("combo", "C1"), ("case", "DEAD")]


def test_geometry_and_restraints(h):
    async def go():
        a = await h.call("add_point", x=0, y=0, z=0)
        await h.call("add_point", x=5, y=0, z=0, name="B")
        f = await h.call("add_frame", point_i=a["name"], point_j="B", section="FSEC1")
        many = await h.call("add_frames", frames=[[5, 0, 0, 5, 0, 3], [0, 0, 0, 0, 0, 3]])
        await h.call("set_restraints", points=[a["name"]], preset="pinned")
        await h.call("set_restraints", points=["B"], dofs=[False, True, True, False, False, False])
        pts = await h.call("list_points")
        area = await h.call("add_area", points=[{"x": 0, "y": 0, "z": 3}, {"x": 5, "y": 0, "z": 3}, {"x": 5, "y": 4, "z": 3}, {"x": 0, "y": 4, "z": 3}])
        await h.call("add_shell_section", name="SLAB200", material="4000Psi", thickness=0.2)
        await h.call("assign_area_section", areas=[area["name"]], section="SLAB200")
        await h.call("assign_area_uniform_load", areas=["ALL"], pattern="DEAD", value=5)
        areas = await h.call("list_areas")
        return f, many, pts, areas

    f, many, pts, areas = run(go())
    assert f["section"] == "FSEC1"
    assert many["count"] == 2
    by_name = {p["name"]: p for p in pts["rows"]}
    assert by_name["1"]["restraint"] == "111000"
    assert by_name["B"]["restraint"] == "011000"
    assert areas["rows"][0]["section"] == "SLAB200" and len(areas["rows"][0]["points"]) == 4


def test_errors_are_reported(h):
    msg = run(h.fail("set_units", units="furlongs"))
    assert "Unknown units" in msg
    msg = run(h.fail("add_frame", xi=0, yi=0, zi=0))
    assert "Give all of" in msg
    msg = run(h.fail("run_analysis"))
    assert "Save the model" in msg
    msg = run(h.fail("add_frame", point_i="nope", point_j="nope2"))
    assert "FrameObj.AddByPoint failed" in msg
    msg = run(h.fail("add_frame_section", name="X", material="S", shape="tube", depth=1))
    assert "tube needs" in msg


def test_tables_and_escape_hatch(h):
    async def go():
        tables = await h.call("list_tables", filter="joint")
        table = await h.call("get_table", table="Joint Coordinates")
        raw = await h.call("sap_api", path="GetVersion", args=["", 0])
        return tables, table, raw

    tables, table, raw = run(go())
    assert tables["tables"] == ["Joint Coordinates"]
    assert table["rows"] == [{"Joint": "1", "GlobalX": "0"}, {"Joint": "2", "GlobalX": "6"}]
    assert raw == {"outputs": ["26.0.0", 26.0], "status": 0, "ok": True}
    assert "must look like" in run(h.fail("sap_api", path="__class__"))


def test_design_and_modal(h):
    async def go():
        await h.call("new_model", template="2d_frame", stories=1, bays_x=1)
        await h.call("save_model", path="/tmp/sap2000-mcp-test/d.sdb")
        await h.call("run_analysis")
        await h.call("run_design", kind="steel")
        summary = await h.call("get_steel_design_summary")
        modal = await h.call("get_modal_periods")
        return summary, modal

    summary, modal = run(go())
    ratios = [r["ratio"] for r in summary["rows"]]
    assert ratios == sorted(ratios, reverse=True)
    assert modal["rows"][0]["period"] == 0.5


def test_disconnect_and_close(h):
    run(h.call("get_model_info"))
    run(h.call("disconnect", close_program=True))
    assert h.sap.exited
