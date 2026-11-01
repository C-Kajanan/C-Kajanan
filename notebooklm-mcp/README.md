# NotebookLM MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Google NotebookLM](https://notebooklm.google.com). It lets Claude (or any MCP client) create notebooks, add sources, chat with them and get answers with citations, run web research, and generate and download Studio artifacts: Audio Overviews (podcasts), Video Overviews, reports, quizzes, flashcards, mind maps, slide decks, infographics and data tables.

```
 Claude / MCP client ──stdio──▶ nblm-mcp (Python) ──HTTPS──▶ NotebookLM (signed in as you)
```

Google does not publish an API for consumer NotebookLM. This server is built on [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py), an unofficial client that calls the same endpoints the NotebookLM web app uses, signed in with your Google cookies. That means:

- It can stop working when Google changes NotebookLM. Upgrading `notebooklm-py` usually fixes it.
- Generation is subject to your account's NotebookLM limits. Audio, video, quiz and slide generation can fail with rate limits; wait a few minutes and retry.
- The saved login (`storage_state.json`) gives full access to your Google account. Keep it private and never commit it.

## Install

You need Python 3.10+.

```bash
git clone https://github.com/C-Kajanan/C-Kajanan.git
cd C-Kajanan/notebooklm-mcp
pip install ".[login]"
```

The `login` extra adds Playwright for the one-time browser sign-in. Install the browser it uses:

```bash
playwright install chromium
```

### Sign in to NotebookLM (once)

```bash
notebooklm login
```

A browser opens. Sign in to Google, wait for NotebookLM to load, then go back to the terminal. Check that it worked:

```bash
notebooklm auth check --test
```

Your session is saved under `~/.notebooklm/`. Run `notebooklm login` again whenever the tools start reporting auth errors.

## Connect your MCP client

Claude Code:

```bash
claude mcp add notebooklm -- nblm-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "nblm-mcp"
    }
  }
}
```

If `nblm-mcp` is not on the client's `PATH` (for example, you installed into a virtualenv), use the full path to the executable, or `"command": "python", "args": ["-m", "nblm_mcp"]` with that environment's Python.

### Options

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--profile` | `NOTEBOOKLM_PROFILE` | `default` | `notebooklm-py` profile (one per Google account) |
| `--storage` | `NOTEBOOKLM_MCP_STORAGE` | profile's `storage_state.json` | Use a specific login file |
| — | `NOTEBOOKLM_AUTH_JSON` | — | Login JSON passed inline, for CI or containers |
| `--download-dir` | `NOTEBOOKLM_MCP_DOWNLOAD_DIR` | `~/Downloads/notebooklm` | Where `download_artifact` saves files |
| `--transport` | — | `stdio` | `stdio` or `streamable-http` |

## Tools

| Area | Tools |
| --- | --- |
| Notebooks | `list_notebooks`, `create_notebook`, `rename_notebook`, `get_notebook_summary`, `delete_notebook` |
| Sources | `list_sources`, `add_url_source` (web pages, YouTube), `add_text_source`, `add_file_source` (PDF, DOCX, MD, EPUB, audio, video, images), `wait_for_sources`, `get_source_text`, `get_source_guide`, `delete_source` |
| Chat | `ask` — answer grounded in the sources, with numbered citations mapped to `source_id` and cited text; pass `conversation_id` for follow-ups |
| Notes | `list_notes`, `create_note` |
| Research | `start_research` (web or Drive, fast or deep), `get_research_status`, `import_research_sources` |
| Studio | `generate_audio_overview`, `generate_video_overview`, `generate_report`, `generate_quiz`, `generate_flashcards`, `generate_mind_map`, `generate_slide_deck`, `generate_infographic`, `generate_data_table` |
| Artifacts | `list_artifacts`, `get_artifact_status`, `wait_for_artifact`, `download_artifact`, `delete_artifact` |

The `delete_*` tools refuse to run unless called with `confirm: true`, and are marked destructive so clients ask before running them. `download_artifact` only writes inside the download folder.

Generation runs on Google's side and takes a while: mind maps are immediate, reports and quizzes take 5–15 minutes, audio 10–20, video 15–45. The `generate_*` tools return a `task_id` straight away; check it with `get_artifact_status`, or block with `wait_for_artifact`.

## Example prompts

- "Make a NotebookLM notebook called *Transformer papers*, add https://arxiv.org/abs/1706.03762, and tell me what the paper says about positional encoding, with citations."
- "Run deep research on *passive house retrofits in cold climates* in my *Retrofit* notebook and import the best sources."
- "Generate a short debate-style audio overview of that notebook and download it when it's ready."
- "Make a hard quiz from the notebook and save it as markdown."

## Development

```bash
pip install -e ".[dev]"
pytest
```

The tests start the MCP server in-process and drive it with an MCP client against a fake NotebookLM client, so they need no Google account.

## License

MIT
