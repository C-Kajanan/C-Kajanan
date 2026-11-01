"""Tests that drive the MCP server in-process against a fake NotebookLM client."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp import Client
from notebooklm import (
    AskResult,
    ChatReference,
    GenerationStatus,
    Notebook,
    ResearchSource,
    ResearchTask,
    Source,
)
from notebooklm.rpc import types as rt

from nblm_mcp.server import create_server, resolve_download_path, to_jsonable


class FakeAPI(SimpleNamespace):
    """Records calls; each attribute is an async function."""


def _rec(calls: list, name: str, result):
    async def fn(*args, **kwargs):
        calls.append((name, args, kwargs))
        return result(*args, **kwargs) if callable(result) else result

    return fn


class FakeClient:
    def __init__(self) -> None:
        self.calls: list = []
        c = self.calls
        nb = Notebook(id="nb1", title="Research", created_at=dt.datetime(2026, 1, 2))
        src = Source(id="src1", title="Example", url="https://example.com")
        self.notebooks = FakeAPI(
            list=_rec(c, "notebooks.list", [nb]),
            create=_rec(c, "notebooks.create", lambda title: Notebook(id="nb2", title=title)),
            rename=_rec(c, "notebooks.rename", nb),
            delete=_rec(c, "notebooks.delete", None),
            get_description=_rec(c, "notebooks.get_description", {"summary": "s"}),
        )
        self.sources = FakeAPI(
            list=_rec(c, "sources.list", [src]),
            add_url=_rec(c, "sources.add_url", src),
            add_text=_rec(c, "sources.add_text", src),
            add_file=_rec(c, "sources.add_file", src),
            wait_for_sources=_rec(c, "sources.wait_for_sources", [src]),
            delete=_rec(c, "sources.delete", None),
        )
        self.chat = FakeAPI(
            ask=_rec(
                c,
                "chat.ask",
                AskResult(
                    answer="X is Y [1]",
                    conversation_id="conv1",
                    turn_number=1,
                    is_follow_up=False,
                    references=[
                        ChatReference(source_id="src1", citation_number=1, cited_text="Y")
                    ],
                    raw_response="<huge>",
                ),
            )
        )
        research_src = ResearchSource(url="https://a.example", title="A")
        other_src = ResearchSource(url="https://b.example", title="B")
        self.research = FakeAPI(
            poll=_rec(
                c,
                "research.poll",
                ResearchTask(
                    task_id="t1", status="completed", query="q",
                    sources=[research_src, other_src],
                ),
            ),
            import_sources=_rec(
                c, "research.import_sources", lambda nb, t, s: [{"url": x.url} for x in s]
            ),
        )

        async def download_report(notebook_id, output_path, artifact_id=None):
            c.append(("artifacts.download_report", (notebook_id, output_path, artifact_id), {}))
            Path(output_path).write_text("# report")
            return output_path

        async def download_quiz(notebook_id, output_path, artifact_id=None, output_format="json"):
            c.append(("artifacts.download_quiz", (notebook_id, output_path), {"fmt": output_format}))
            Path(output_path).write_text("{}")
            return output_path

        self.artifacts = FakeAPI(
            generate_audio=_rec(
                c, "artifacts.generate_audio", GenerationStatus(task_id="task1", status="pending")
            ),
            delete=_rec(c, "artifacts.delete", None),
            download_report=download_report,
            download_quiz=download_quiz,
        )

    def last(self, name):
        return [call for call in self.calls if call[0] == name][-1]


class FakeHolder:
    def __init__(self) -> None:
        self.client = FakeClient()
        self.closed = False

    async def get(self):
        return self.client

    async def close(self):
        self.closed = True


@pytest.fixture
def holder():
    return FakeHolder()


@pytest.fixture
def server(holder, tmp_path):
    return create_server(holder=holder, download_dir=tmp_path)


def payload(result):
    assert not result.is_error, result.content
    if result.structured_content is not None:
        data = result.structured_content
        return data.get("result", data) if isinstance(data, dict) else data
    return json.loads(result.content[0].text)


async def test_lists_expected_tools(server):
    async with Client(server) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
    for name in [
        "list_notebooks", "create_notebook", "delete_notebook", "add_url_source",
        "add_file_source", "ask", "start_research", "import_research_sources",
        "generate_audio_overview", "generate_slide_deck", "wait_for_artifact",
        "download_artifact", "delete_artifact",
    ]:
        assert name in tools
    assert tools["delete_notebook"].annotations.destructive_hint is True
    assert tools["list_notebooks"].annotations.read_only_hint is True


async def test_list_notebooks_serializes(server):
    async with Client(server) as client:
        data = payload(await client.call_tool("list_notebooks", {}))
    assert data[0]["id"] == "nb1"
    assert data[0]["created_at"] == "2026-01-02T00:00:00"


async def test_ask_returns_compact_references(server, holder):
    async with Client(server) as client:
        data = payload(
            await client.call_tool("ask", {"notebook_id": "nb1", "question": "What is X?"})
        )
    assert data["answer"] == "X is Y [1]"
    assert data["references"] == [{"citation_number": 1, "source_id": "src1", "cited_text": "Y"}]
    assert "raw_response" not in data
    assert holder.client.last("chat.ask")[1] == ("nb1", "What is X?")


async def test_delete_requires_confirm(server, holder):
    async with Client(server) as client:
        refused = await client.call_tool("delete_notebook", {"notebook_id": "nb1"})
        assert refused.is_error
        assert "confirm=true" in refused.content[0].text
        assert not [c for c in holder.client.calls if c[0] == "notebooks.delete"]
        ok = payload(
            await client.call_tool("delete_notebook", {"notebook_id": "nb1", "confirm": True})
        )
    assert ok == {"deleted": "nb1"}


async def test_generate_audio_maps_enums(server, holder):
    async with Client(server) as client:
        data = payload(
            await client.call_tool(
                "generate_audio_overview",
                {"notebook_id": "nb1", "audio_format": "debate", "length": "short"},
            )
        )
    assert data["task_id"] == "task1"
    kwargs = holder.client.last("artifacts.generate_audio")[2]
    assert kwargs["audio_format"] is rt.AudioFormat.DEBATE
    assert kwargs["audio_length"] is rt.AudioLength.SHORT


async def test_add_file_source_checks_path(server, holder, tmp_path):
    async with Client(server) as client:
        missing = await client.call_tool(
            "add_file_source", {"notebook_id": "nb1", "file_path": str(tmp_path / "nope.pdf")}
        )
        assert missing.is_error
        f = tmp_path / "doc.txt"
        f.write_text("hi")
        payload(await client.call_tool("add_file_source", {"notebook_id": "nb1", "file_path": str(f)}))
    assert holder.client.last("sources.add_file")[1][1] == f


async def test_import_research_filters_urls(server, holder):
    async with Client(server) as client:
        data = payload(
            await client.call_tool(
                "import_research_sources",
                {"notebook_id": "nb1", "task_id": "t1", "urls": ["https://b.example"]},
            )
        )
    assert data["imported"] == [{"url": "https://b.example"}]


async def test_download_report_and_quiz(server, tmp_path):
    async with Client(server) as client:
        rep = payload(
            await client.call_tool(
                "download_artifact", {"notebook_id": "nb1", "kind": "report", "filename": "r.md"}
            )
        )
        quiz = payload(
            await client.call_tool(
                "download_artifact",
                {"notebook_id": "nb1", "kind": "quiz", "file_format": "markdown"},
            )
        )
        bad = await client.call_tool(
            "download_artifact",
            {"notebook_id": "nb1", "kind": "report", "filename": "../escape.md"},
        )
    assert Path(rep["path"]) == (tmp_path / "r.md").resolve()
    assert Path(rep["path"]).read_text() == "# report"
    assert quiz["path"].endswith(".md")
    assert bad.is_error
    assert "inside the download folder" in bad.content[0].text


def test_resolve_download_path_blocks_escape(tmp_path):
    assert resolve_download_path(tmp_path, "a/b.mp3") == (tmp_path / "a" / "b.mp3").resolve()
    with pytest.raises(ValueError):
        resolve_download_path(tmp_path, "/etc/passwd")


def test_to_jsonable_handles_enums_and_private_fields():
    src = Source(id="s", title="t")
    data = to_jsonable(src)
    assert "_type_code" not in data
    assert "kind" in data
    assert to_jsonable(rt.AudioFormat.BRIEF) == rt.AudioFormat.BRIEF.value


async def test_notebooklm_errors_reach_the_model(tmp_path):
    from notebooklm import RateLimitError

    class Broken(FakeHolder):
        async def get(self):
            async def boom():
                raise RateLimitError("slow down")

            return SimpleNamespace(notebooks=SimpleNamespace(list=boom))

    async with Client(create_server(holder=Broken(), download_dir=tmp_path)) as client:
        r = await client.call_tool("list_notebooks", {})
    assert r.is_error
    assert "RateLimitError" in r.content[0].text and "slow down" in r.content[0].text


async def test_missing_login_says_how_to_fix(tmp_path):
    server = create_server(storage=str(tmp_path / "missing.json"), download_dir=tmp_path)
    async with Client(server) as client:
        r = await client.call_tool("list_notebooks", {})
    assert r.is_error
    assert "notebooklm login" in r.content[0].text
