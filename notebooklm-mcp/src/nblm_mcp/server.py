"""NotebookLM MCP server.

Exposes Google NotebookLM (notebooks, sources, chat, notes, research and
Studio artifacts) as MCP tools. All NotebookLM traffic goes through the
`notebooklm-py` client, which talks to NotebookLM with the cookies saved by
`notebooklm login`.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import datetime as _dt
import enum
import functools
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from notebooklm import NotebookLMClient, NotebookLMError
from notebooklm.rpc import types as rt

from . import __version__

SERVER_NAME = "notebooklm"

INSTRUCTIONS = """\
Tools for Google NotebookLM.

Typical flow: list_notebooks or create_notebook -> add_url_source / add_text_source /
add_file_source -> wait_for_sources -> ask (chat with citations) or generate_* (Studio
artifacts) -> wait_for_artifact -> download_artifact.

Notes:
- Always pass full notebook / source / artifact IDs returned by earlier tools.
- Sources must be ready before chat or generation; call wait_for_sources first.
- generate_* tools return a task_id immediately. Audio and video can take 10-45 minutes.
  Use get_artifact_status to check, or wait_for_artifact with a timeout.
- Delete tools need confirm=true. Ask the user before deleting anything.
"""


# --------------------------------------------------------------------------- #
# Client lifecycle
# --------------------------------------------------------------------------- #


class _ClientHolder:
    """Creates one NotebookLMClient on first use and reuses it."""

    def __init__(self, storage: str | None, profile: str | None) -> None:
        self.storage = storage
        self.profile = profile
        self._client: NotebookLMClient | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> NotebookLMClient:
        async with self._lock:
            if self._client is None:
                stack = AsyncExitStack()
                try:
                    client = await stack.enter_async_context(
                        NotebookLMClient.from_storage(path=self.storage, profile=self.profile)
                    )
                except BaseException:
                    await stack.aclose()
                    raise
                self._stack, self._client = stack, client
            return self._client

    async def close(self) -> None:
        async with self._lock:
            if self._stack is not None:
                await self._stack.aclose()
            self._stack = self._client = None


# --------------------------------------------------------------------------- #
# Serialization helpers
# --------------------------------------------------------------------------- #

_SKIP_FIELDS = {"raw_response", "artifacts_data"}


def to_jsonable(value: Any) -> Any:
    """Convert notebooklm-py result objects into plain JSON data."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v) for v in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: dict[str, Any] = {}
        for f in dataclasses.fields(value):
            if f.name.startswith("_") or f.name in _SKIP_FIELDS:
                continue
            out[f.name] = to_jsonable(getattr(value, f.name))
        # Public "kind" properties hide the private type codes we skipped.
        kind = getattr(type(value), "kind", None)
        if isinstance(kind, property):
            try:
                out["kind"] = to_jsonable(value.kind)
            except Exception:  # noqa: BLE001 - best effort only
                pass
        return out
    return str(value)


def _enum(enum_cls: type[enum.Enum], name: str | None) -> Any:
    """Map a lowercase, dash-or-underscore option to an enum member."""
    if name is None:
        return None
    key = name.strip().upper().replace("-", "_").replace(" ", "_")
    try:
        return enum_cls[key]
    except KeyError as exc:
        options = ", ".join(m.name.lower() for m in enum_cls)
        raise ValueError(f"Unknown option {name!r}. Use one of: {options}") from exc


def _require_confirm(confirm: bool, what: str) -> None:
    if not confirm:
        raise ValueError(
            f"Refusing to delete {what} without confirm=true. "
            "Ask the user first, then call again with confirm=true."
        )


def _friendly_errors(fn):
    """Show expected failures to the model instead of a generic crash message."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except ToolError:
            raise
        except FileNotFoundError as exc:
            msg = str(exc)
            if "notebooklm login" not in msg:
                msg += " (sign in with `notebooklm login` on the machine running this server)"
            raise ToolError(msg) from exc
        except NotebookLMError as exc:
            raise ToolError(f"{type(exc).__name__}: {exc}") from exc
        except (ValueError, TimeoutError) as exc:
            raise ToolError(str(exc) or type(exc).__name__) from exc

    return wrapper


# --------------------------------------------------------------------------- #
# Download location
# --------------------------------------------------------------------------- #

_DOWNLOAD_EXT = {
    "audio": ".mp3",
    "video": ".mp4",
    "report": ".md",
    "mind_map": ".json",
    "infographic": ".png",
    "data_table": ".csv",
}


def default_download_dir() -> Path:
    env = os.environ.get("NOTEBOOKLM_MCP_DOWNLOAD_DIR")
    return Path(env).expanduser() if env else Path.home() / "Downloads" / "notebooklm"


def resolve_download_path(download_dir: Path, filename: str) -> Path:
    """Resolve `filename` inside `download_dir`, rejecting paths that escape it."""
    base = download_dir.expanduser().resolve()
    target = (base / filename).resolve()
    if base != target.parent and base not in target.parents:
        raise ValueError(f"filename must stay inside the download folder ({base})")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


# --------------------------------------------------------------------------- #
# Server
# --------------------------------------------------------------------------- #

ArtifactKind = Literal[
    "audio",
    "video",
    "report",
    "quiz",
    "flashcards",
    "mind_map",
    "slide_deck",
    "infographic",
    "data_table",
]

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=True)


def create_server(
    storage: str | None = None,
    profile: str | None = None,
    download_dir: Path | None = None,
    holder: Any = None,
) -> MCPServer:
    """Build the MCP server. `holder` lets tests inject a fake client."""
    holder = holder or _ClientHolder(storage, profile)
    downloads = download_dir or default_download_dir()

    @asynccontextmanager
    async def lifespan(_server: MCPServer) -> AsyncIterator[None]:
        try:
            yield None
        finally:
            await holder.close()

    mcp = MCPServer(
        name=SERVER_NAME,
        title="NotebookLM",
        instructions=INSTRUCTIONS,
        version=__version__,
        lifespan=lifespan,
    )
    _register = mcp.tool

    def tool(**kwargs):
        def deco(fn):
            return _register(**kwargs)(_friendly_errors(fn))

        return deco

    mcp.tool = tool  # type: ignore[method-assign]

    # ----------------------------- notebooks ----------------------------- #

    @mcp.tool(annotations=READ_ONLY)
    async def list_notebooks() -> list[dict]:
        """List all NotebookLM notebooks in the account (id, title, source count, dates)."""
        client = await holder.get()
        return to_jsonable(await client.notebooks.list())

    @mcp.tool(annotations=WRITE)
    async def create_notebook(title: str) -> dict:
        """Create a new, empty notebook and return it (including its id)."""
        client = await holder.get()
        return to_jsonable(await client.notebooks.create(title))

    @mcp.tool(annotations=WRITE)
    async def rename_notebook(notebook_id: str, new_title: str) -> dict:
        """Rename a notebook."""
        client = await holder.get()
        return to_jsonable(await client.notebooks.rename(notebook_id, new_title))

    @mcp.tool(annotations=DESTRUCTIVE)
    async def delete_notebook(notebook_id: str, confirm: bool = False) -> dict:
        """Permanently delete a notebook. Requires confirm=true; ask the user first."""
        _require_confirm(confirm, f"notebook {notebook_id}")
        client = await holder.get()
        await client.notebooks.delete(notebook_id)
        return {"deleted": notebook_id}

    @mcp.tool(annotations=READ_ONLY)
    async def get_notebook_summary(notebook_id: str) -> dict:
        """Get NotebookLM's AI summary of a notebook and its suggested topics."""
        client = await holder.get()
        return to_jsonable(await client.notebooks.get_description(notebook_id))

    # ------------------------------ sources ------------------------------ #

    @mcp.tool(annotations=READ_ONLY)
    async def list_sources(notebook_id: str) -> list[dict]:
        """List the sources in a notebook with their processing status."""
        client = await holder.get()
        return to_jsonable(await client.sources.list(notebook_id))

    @mcp.tool(annotations=WRITE)
    async def add_url_source(
        notebook_id: str, url: str, title: str | None = None, wait: bool = False
    ) -> dict:
        """Add a web page or YouTube URL as a source. Set wait=true to block until it is indexed."""
        client = await holder.get()
        return to_jsonable(
            await client.sources.add_url(notebook_id, url, wait=wait, title=title)
        )

    @mcp.tool(annotations=WRITE)
    async def add_text_source(
        notebook_id: str, title: str, content: str, wait: bool = False
    ) -> dict:
        """Add pasted text (notes, markdown, a transcript...) as a source."""
        client = await holder.get()
        return to_jsonable(
            await client.sources.add_text(notebook_id, title, content, wait=wait)
        )

    @mcp.tool(annotations=WRITE)
    async def add_file_source(
        notebook_id: str, file_path: str, title: str | None = None, wait: bool = False
    ) -> dict:
        """Upload a local file (PDF, DOCX, TXT, MD, EPUB, audio, video, image) as a source.

        file_path is a path on the machine running this server.
        """
        path = Path(file_path).expanduser()
        if not path.is_file():
            raise ValueError(f"File not found: {path}")
        client = await holder.get()
        return to_jsonable(
            await client.sources.add_file(notebook_id, path, wait=wait, title=title)
        )

    @mcp.tool(annotations=READ_ONLY)
    async def wait_for_sources(
        notebook_id: str, source_ids: list[str], timeout_seconds: float = 300
    ) -> list[dict]:
        """Wait until the given sources finish processing, then return them."""
        client = await holder.get()
        return to_jsonable(
            await client.sources.wait_for_sources(
                notebook_id, source_ids, timeout=timeout_seconds
            )
        )

    @mcp.tool(annotations=READ_ONLY)
    async def get_source_text(
        notebook_id: str, source_id: str, max_chars: int = 50000
    ) -> dict:
        """Get the full indexed text of a source (truncated to max_chars)."""
        client = await holder.get()
        full = to_jsonable(
            await client.sources.get_fulltext(
                notebook_id, source_id, output_format="markdown"
            )
        )
        content = full.get("content") or ""
        if max_chars and len(content) > max_chars:
            full["content"] = content[:max_chars]
            full["truncated"] = True
        return full

    @mcp.tool(annotations=READ_ONLY)
    async def get_source_guide(notebook_id: str, source_id: str) -> dict:
        """Get NotebookLM's summary and keywords for one source."""
        client = await holder.get()
        return to_jsonable(await client.sources.get_guide(notebook_id, source_id))

    @mcp.tool(annotations=DESTRUCTIVE)
    async def delete_source(notebook_id: str, source_id: str, confirm: bool = False) -> dict:
        """Remove a source from a notebook. Requires confirm=true; ask the user first."""
        _require_confirm(confirm, f"source {source_id}")
        client = await holder.get()
        await client.sources.delete(notebook_id, source_id)
        return {"deleted": source_id}

    # -------------------------------- chat ------------------------------- #

    @mcp.tool(annotations=READ_ONLY)
    async def ask(
        notebook_id: str,
        question: str,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> dict:
        """Ask a question grounded in the notebook's sources.

        Returns the answer with numbered citations ([1], [2]...) and a references
        list mapping each citation to a source_id and cited text. Pass the returned
        conversation_id to ask follow-up questions in the same thread. Limit the
        answer to specific sources with source_ids.
        """
        client = await holder.get()
        result = await client.chat.ask(
            notebook_id, question, source_ids=source_ids, conversation_id=conversation_id
        )
        data = to_jsonable(result)
        refs = []
        for r in data.get("references") or []:
            refs.append(
                {
                    "citation_number": r.get("citation_number"),
                    "source_id": r.get("source_id"),
                    "cited_text": r.get("cited_text"),
                }
            )
        data["references"] = refs
        return data

    # ------------------------------- notes ------------------------------- #

    @mcp.tool(annotations=READ_ONLY)
    async def list_notes(notebook_id: str) -> list[dict]:
        """List the saved notes in a notebook."""
        client = await holder.get()
        return to_jsonable(await client.notes.list(notebook_id))

    @mcp.tool(annotations=WRITE)
    async def create_note(notebook_id: str, title: str, content: str) -> dict:
        """Save a note in the notebook (for example, an answer worth keeping)."""
        client = await holder.get()
        return to_jsonable(await client.notes.create(notebook_id, title=title, content=content))

    # ------------------------------ research ----------------------------- #

    @mcp.tool(annotations=WRITE)
    async def start_research(
        notebook_id: str,
        query: str,
        mode: Literal["fast", "deep"] = "fast",
        search_in: Literal["web", "drive"] = "web",
    ) -> dict:
        """Start NotebookLM web (or Google Drive) research for a query.

        fast finishes in about a minute; deep can take 15-30 minutes. Check it with
        get_research_status and import results with import_research_sources.
        """
        client = await holder.get()
        return to_jsonable(
            await client.research.start(notebook_id, query, source=search_in, mode=mode)
        )

    @mcp.tool(annotations=READ_ONLY)
    async def get_research_status(notebook_id: str, task_id: str | None = None) -> dict:
        """Get the status, found sources and summary of a research task."""
        client = await holder.get()
        return to_jsonable(await client.research.poll(notebook_id, task_id))

    @mcp.tool(annotations=WRITE)
    async def import_research_sources(
        notebook_id: str, task_id: str, urls: list[str] | None = None
    ) -> dict:
        """Import sources found by a finished research task into the notebook.

        Pass urls to import only some of them; omit to import all found sources.
        """
        client = await holder.get()
        task = await client.research.poll(notebook_id, task_id)
        found = list(task.sources or [])
        if urls:
            wanted = set(urls)
            found = [s for s in found if getattr(s, "url", None) in wanted]
        if not found:
            return {"imported": [], "message": "No matching research sources to import."}
        imported = await client.research.import_sources(notebook_id, task_id, found)
        return {"imported": to_jsonable(imported)}

    # ----------------------------- artifacts ----------------------------- #

    @mcp.tool(annotations=READ_ONLY)
    async def list_artifacts(notebook_id: str, kind: ArtifactKind | None = None) -> list[dict]:
        """List Studio artifacts (audio, video, reports, quizzes...) in a notebook."""
        client = await holder.get()
        artifact_type = _enum(rt.ArtifactType, kind) if kind else None
        return to_jsonable(await client.artifacts.list(notebook_id, artifact_type))

    @mcp.tool(annotations=WRITE)
    async def generate_audio_overview(
        notebook_id: str,
        instructions: str | None = None,
        audio_format: Literal["deep_dive", "brief", "critique", "debate"] | None = None,
        length: Literal["short", "default", "long"] | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating an Audio Overview (podcast). Takes about 10-20 minutes."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_audio(
                notebook_id,
                source_ids=source_ids,
                language=language,
                instructions=instructions,
                audio_format=_enum(rt.AudioFormat, audio_format),
                audio_length=_enum(rt.AudioLength, length),
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_video_overview(
        notebook_id: str,
        instructions: str | None = None,
        video_format: Literal["explainer", "brief", "cinematic", "short"] | None = None,
        style: Literal[
            "auto_select", "custom", "classic", "whiteboard", "kawaii", "anime",
            "watercolor", "retro_print", "heritage", "paper_craft",
        ] | None = None,
        style_prompt: str | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating a Video Overview. Takes about 15-45 minutes."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_video(
                notebook_id,
                source_ids=source_ids,
                language=language,
                instructions=instructions,
                video_format=_enum(rt.VideoFormat, video_format),
                video_style=_enum(rt.VideoStyle, style),
                style_prompt=style_prompt,
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_report(
        notebook_id: str,
        report_format: Literal["briefing_doc", "study_guide", "blog_post", "custom"] = "briefing_doc",
        custom_prompt: str | None = None,
        extra_instructions: str | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating a written report. Use report_format='custom' with custom_prompt."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_report(
                notebook_id,
                report_format=_enum(rt.ReportFormat, report_format),
                source_ids=source_ids,
                language=language,
                custom_prompt=custom_prompt,
                extra_instructions=extra_instructions,
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_quiz(
        notebook_id: str,
        instructions: str | None = None,
        difficulty: Literal["easy", "medium", "hard"] | None = None,
        quantity: Literal["fewer", "standard"] | None = None,
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating a quiz."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_quiz(
                notebook_id,
                source_ids=source_ids,
                instructions=instructions,
                quantity=_enum(rt.QuizQuantity, quantity),
                difficulty=_enum(rt.QuizDifficulty, difficulty),
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_flashcards(
        notebook_id: str,
        instructions: str | None = None,
        difficulty: Literal["easy", "medium", "hard"] | None = None,
        quantity: Literal["fewer", "standard"] | None = None,
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating flashcards."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_flashcards(
                notebook_id,
                source_ids=source_ids,
                instructions=instructions,
                quantity=_enum(rt.QuizQuantity, quantity),
                difficulty=_enum(rt.QuizDifficulty, difficulty),
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_mind_map(
        notebook_id: str,
        instructions: str | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Generate a mind map of the notebook's concepts and return its tree."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_mind_map(
                notebook_id, source_ids=source_ids, language=language, instructions=instructions
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_slide_deck(
        notebook_id: str,
        instructions: str | None = None,
        slide_format: Literal["detailed_deck", "presenter_slides"] | None = None,
        length: Literal["default", "short"] | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating a slide deck (downloadable as PDF or PPTX)."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_slide_deck(
                notebook_id,
                source_ids=source_ids,
                language=language,
                instructions=instructions,
                slide_format=_enum(rt.SlideDeckFormat, slide_format),
                slide_length=_enum(rt.SlideDeckLength, length),
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_infographic(
        notebook_id: str,
        instructions: str | None = None,
        orientation: Literal["landscape", "portrait", "square"] | None = None,
        detail: Literal["concise", "standard", "detailed"] | None = None,
        style: Literal[
            "auto_select", "sketch_note", "professional", "bento_grid", "editorial",
            "instructional", "bricks", "clay", "anime", "kawaii", "scientific",
        ] | None = None,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating an infographic image."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_infographic(
                notebook_id,
                source_ids=source_ids,
                language=language,
                instructions=instructions,
                orientation=_enum(rt.InfographicOrientation, orientation),
                detail_level=_enum(rt.InfographicDetail, detail),
                style=_enum(rt.InfographicStyle, style),
            )
        )

    @mcp.tool(annotations=WRITE)
    async def generate_data_table(
        notebook_id: str,
        instructions: str,
        language: str = "en",
        source_ids: list[str] | None = None,
    ) -> dict:
        """Start generating a data table. Describe the columns/rows you want in instructions."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.generate_data_table(
                notebook_id, source_ids=source_ids, language=language, instructions=instructions
            )
        )

    @mcp.tool(annotations=READ_ONLY)
    async def get_artifact_status(notebook_id: str, task_id: str) -> dict:
        """Check a generation task once (pending, in_progress, completed or failed)."""
        client = await holder.get()
        return to_jsonable(await client.artifacts.poll_status(notebook_id, task_id))

    @mcp.tool(annotations=READ_ONLY)
    async def wait_for_artifact(
        notebook_id: str, task_id: str, timeout_seconds: float = 600
    ) -> dict:
        """Wait for a generation task to finish, up to timeout_seconds."""
        client = await holder.get()
        return to_jsonable(
            await client.artifacts.wait_for_completion(
                notebook_id, task_id, timeout=timeout_seconds
            )
        )

    @mcp.tool(annotations=WRITE)
    async def download_artifact(
        notebook_id: str,
        kind: ArtifactKind,
        artifact_id: str | None = None,
        filename: str | None = None,
        file_format: Literal["json", "markdown", "html", "pdf", "pptx"] | None = None,
    ) -> dict:
        """Download a completed artifact to the server's download folder.

        Omit artifact_id to get the latest one of that kind. file_format applies to
        quiz/flashcards (json, markdown, html) and slide_deck (pdf, pptx). Returns the
        saved file path.
        """
        client = await holder.get()
        fmt = file_format
        if kind in ("quiz", "flashcards"):
            fmt = fmt or "json"
            if fmt not in ("json", "markdown", "html"):
                raise ValueError("quiz/flashcards support json, markdown or html")
            ext = {"json": ".json", "markdown": ".md", "html": ".html"}[fmt]
        elif kind == "slide_deck":
            fmt = fmt or "pdf"
            if fmt not in ("pdf", "pptx"):
                raise ValueError("slide_deck supports pdf or pptx")
            ext = "." + fmt
        else:
            ext = _DOWNLOAD_EXT[kind]
        name = filename or f"{kind}-{(artifact_id or 'latest')[:12]}{ext}"
        out = resolve_download_path(downloads, name)

        api = client.artifacts
        method = getattr(api, f"download_{kind}")
        if kind in ("quiz", "flashcards", "slide_deck"):
            saved = await method(notebook_id, str(out), artifact_id, output_format=fmt)
        else:
            saved = await method(notebook_id, str(out), artifact_id)
        return {"path": str(saved), "kind": kind}

    @mcp.tool(annotations=DESTRUCTIVE)
    async def delete_artifact(notebook_id: str, artifact_id: str, confirm: bool = False) -> dict:
        """Delete a Studio artifact. Requires confirm=true; ask the user first."""
        _require_confirm(confirm, f"artifact {artifact_id}")
        client = await holder.get()
        await client.artifacts.delete(notebook_id, artifact_id)
        return {"deleted": artifact_id}

    return mcp


def main() -> None:
    parser = argparse.ArgumentParser(prog="nblm-mcp", description=__doc__)
    parser.add_argument(
        "--storage",
        default=os.environ.get("NOTEBOOKLM_MCP_STORAGE"),
        help="Path to storage_state.json (default: the notebooklm-py profile)",
    )
    parser.add_argument(
        "--profile",
        default=os.environ.get("NOTEBOOKLM_PROFILE"),
        help="notebooklm-py profile name (default: 'default')",
    )
    parser.add_argument(
        "--download-dir",
        type=Path,
        default=None,
        help="Folder for downloaded artifacts (default: ~/Downloads/notebooklm)",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default="stdio",
        help="MCP transport (default: stdio)",
    )
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()

    server = create_server(args.storage, args.profile, args.download_dir)
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()
