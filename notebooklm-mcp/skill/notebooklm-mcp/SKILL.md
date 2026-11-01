---
name: notebooklm-mcp
description: Use Google NotebookLM through the nblm-mcp server - create notebooks, add sources (web pages, YouTube, PDFs, files, text), ask questions answered with citations, run web or Drive research, and generate and download Audio Overviews (podcasts), Video Overviews, reports, quizzes, flashcards, mind maps, slide decks, infographics and data tables. Use when the user mentions NotebookLM, or asks to turn sources into a podcast, study guide, quiz, flashcards, slides or mind map, or wants answers grounded in documents they add. Also covers installing and connecting the server when its tools are missing.
---

# NotebookLM (MCP)

This skill drives Google NotebookLM through the `nblm-mcp` MCP server. Its tools appear as `mcp__notebooklm__<tool>` (for example `mcp__notebooklm__list_notebooks`).

## 1. Make sure the server is connected

Check whether the `mcp__notebooklm__*` tools are available.

- **Available:** call `list_notebooks`. If it works, go to step 2. If it errors with "Storage file not found" or another auth error, the user must sign in again: ask them to run `notebooklm login` (or the exact command `setup.sh` printed) in their own terminal (it opens a browser), then retry.
- **Missing:** run the setup script from this skill's folder, which installs the server and registers it with Claude Code:

  ```bash
  bash scripts/setup.sh
  ```

  The script installs `nblm-mcp` (with uv, pipx or pip, whichever it finds), installs Chromium for the login, registers the server with `claude mcp add`, and tells the user to run `notebooklm login` if they have not signed in yet. `notebooklm login` needs a browser and a person, so never run it yourself in a headless session; ask the user to run it. After setup, the user has to restart Claude Code (or reload MCP servers) before the tools appear.

  For Claude Desktop or another client, give the user this config instead:

  ```json
  { "mcpServers": { "notebooklm": { "command": "nblm-mcp" } } }
  ```

The saved login (`~/.notebooklm/.../storage_state.json`) is a full Google credential. Never print it, commit it, or send it anywhere.

## 2. Work with notebooks

Always use the full IDs returned by earlier calls. Never guess IDs; call `list_notebooks`, `list_sources` or `list_artifacts` to find them.

### Ask questions about documents

1. `create_notebook(title)`, or pick an existing one from `list_notebooks`.
2. Add each source: `add_url_source` (web page or YouTube), `add_file_source` (local path on the machine running the server), or `add_text_source`. If one source fails, tell the user and continue with the rest.
3. `wait_for_sources(notebook_id, source_ids)`. Chat and generation fail on sources that are still processing.
4. `ask(notebook_id, question)`. Show the answer with its citation numbers, and list which source each citation comes from (match `references[].source_id` to the source titles). Pass the returned `conversation_id` for follow-up questions. Use `source_ids` to limit an answer to some sources.
5. If the user wants to keep an answer, `create_note`.

### Research a topic

1. `start_research(notebook_id, query, mode="fast")`. Use `mode="deep"` only when the user wants a broad survey; it takes 15-30 minutes.
2. `get_research_status(notebook_id, task_id)` until it is completed. Show the user the sources it found.
3. `import_research_sources(notebook_id, task_id)` imports everything; pass `urls` to import only the ones the user picked.

### Generate Studio content

| User wants | Tool | Typical time |
| --- | --- | --- |
| Podcast / audio overview | `generate_audio_overview` (`audio_format`: deep_dive, brief, critique, debate; `length`: short, default, long) | 10-20 min |
| Video explainer | `generate_video_overview` (`video_format`, `style`) | 15-45 min |
| Briefing doc, study guide, blog post | `generate_report` (`report_format`; `custom` + `custom_prompt` for anything else) | 5-15 min |
| Quiz / flashcards | `generate_quiz` / `generate_flashcards` (`difficulty`, `quantity`) | 5-15 min |
| Mind map | `generate_mind_map` | immediate, returns the tree |
| Slides | `generate_slide_deck` (`slide_format`, `length`) | 5-15 min |
| Infographic | `generate_infographic` (`orientation`, `detail`, `style`) | 5-15 min |
| Table of facts | `generate_data_table` (describe the columns in `instructions`) | 5-15 min |

All `generate_*` tools except mind maps return a `task_id` straight away. Then:

1. Tell the user it has started and roughly how long it takes.
2. Check with `get_artifact_status(notebook_id, task_id)`, or block with `wait_for_artifact(notebook_id, task_id, timeout_seconds)` when the user wants to wait. Don't poll more than every 30 seconds.
3. When it is completed, `download_artifact(notebook_id, kind, artifact_id)`. `file_format` picks json, markdown or html for quizzes and flashcards, and pdf or pptx for slide decks. Report the saved path.

Generation tools change the user's account and can use up NotebookLM quota, so start one only when the user asked for that artifact. Audio, video, quiz, flashcard, infographic and slide generation can fail with `RateLimitError`; tell the user, wait a few minutes, and retry once.

## 3. Deleting

`delete_notebook`, `delete_source` and `delete_artifact` are permanent and only run with `confirm=true`. Ask the user and name exactly what will be deleted before passing `confirm=true`.

## Errors

| Error | What to do |
| --- | --- |
| Storage file not found / AuthError | User runs `notebooklm login`, then retry |
| RateLimitError | Wait 5-10 minutes, retry once, otherwise suggest the NotebookLM web app |
| NotFoundError | The ID is wrong or was deleted; list again |
| Source still processing | `wait_for_sources` first |
| RPC or decoding errors | Google changed NotebookLM; the user should upgrade with `pip install -U notebooklm-py nblm-mcp` |

The full list of tools and parameters is in `references/tools.md`.
