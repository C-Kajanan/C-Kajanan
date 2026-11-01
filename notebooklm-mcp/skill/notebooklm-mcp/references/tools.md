# nblm-mcp tool reference

Optional parameters are shown with their default. `source_ids` on chat and generation tools limits the work to those sources; omit it to use the whole notebook. `language` is a NotebookLM language code such as `en`, `ja`, `es`, `zh_Hans`.

## Notebooks

| Tool | Parameters | Returns |
| --- | --- | --- |
| `list_notebooks` | — | id, title, sources_count, is_owner, created_at, modified_at |
| `create_notebook` | `title` | the new notebook |
| `rename_notebook` | `notebook_id`, `new_title` | the notebook |
| `get_notebook_summary` | `notebook_id` | AI summary and suggested topics |
| `delete_notebook` | `notebook_id`, `confirm=false` | `{deleted}`; refuses without `confirm=true` |

## Sources

| Tool | Parameters | Returns |
| --- | --- | --- |
| `list_sources` | `notebook_id` | id, title, url, kind, status |
| `add_url_source` | `notebook_id`, `url`, `title=null`, `wait=false` | the source |
| `add_text_source` | `notebook_id`, `title`, `content`, `wait=false` | the source |
| `add_file_source` | `notebook_id`, `file_path`, `title=null`, `wait=false` | the source; path is on the server's machine |
| `wait_for_sources` | `notebook_id`, `source_ids`, `timeout_seconds=300` | the ready sources |
| `get_source_text` | `notebook_id`, `source_id`, `max_chars=50000` | indexed text (markdown), `truncated` if cut |
| `get_source_guide` | `notebook_id`, `source_id` | summary and keywords |
| `delete_source` | `notebook_id`, `source_id`, `confirm=false` | `{deleted}` |

## Chat and notes

| Tool | Parameters | Returns |
| --- | --- | --- |
| `ask` | `notebook_id`, `question`, `source_ids=null`, `conversation_id=null` | answer, conversation_id, turn_number, references[{citation_number, source_id, cited_text}] |
| `list_notes` | `notebook_id` | notes |
| `create_note` | `notebook_id`, `title`, `content` | the note |

## Research

| Tool | Parameters | Returns |
| --- | --- | --- |
| `start_research` | `notebook_id`, `query`, `mode="fast"` (fast, deep), `search_in="web"` (web, drive) | task_id |
| `get_research_status` | `notebook_id`, `task_id=null` | status, sources found, summary |
| `import_research_sources` | `notebook_id`, `task_id`, `urls=null` | imported sources |

## Studio artifacts

Every generate tool takes `notebook_id` first.

| Tool | Options |
| --- | --- |
| `generate_audio_overview` | `instructions`, `audio_format` (deep_dive, brief, critique, debate), `length` (short, default, long), `language`, `source_ids` |
| `generate_video_overview` | `instructions`, `video_format` (explainer, brief, cinematic, short), `style` (auto_select, custom, classic, whiteboard, kawaii, anime, watercolor, retro_print, heritage, paper_craft), `style_prompt` (with `style=custom`), `language`, `source_ids` |
| `generate_report` | `report_format` (briefing_doc, study_guide, blog_post, custom), `custom_prompt`, `extra_instructions`, `language`, `source_ids` |
| `generate_quiz` | `instructions`, `difficulty` (easy, medium, hard), `quantity` (fewer, standard), `source_ids` |
| `generate_flashcards` | same as quiz |
| `generate_mind_map` | `instructions`, `language`, `source_ids`; returns the mind map tree directly |
| `generate_slide_deck` | `instructions`, `slide_format` (detailed_deck, presenter_slides), `length` (default, short), `language`, `source_ids` |
| `generate_infographic` | `instructions`, `orientation` (landscape, portrait, square), `detail` (concise, standard, detailed), `style` (auto_select, sketch_note, professional, bento_grid, editorial, instructional, bricks, clay, anime, kawaii, scientific), `language`, `source_ids` |
| `generate_data_table` | `instructions` (required), `language`, `source_ids` |

Generation tools return `{task_id, status}` except `generate_mind_map`.

| Tool | Parameters | Returns |
| --- | --- | --- |
| `list_artifacts` | `notebook_id`, `kind=null` | artifacts with id, title, kind, status |
| `get_artifact_status` | `notebook_id`, `task_id` | status: pending, in_progress, completed, failed |
| `wait_for_artifact` | `notebook_id`, `task_id`, `timeout_seconds=600` | final status |
| `download_artifact` | `notebook_id`, `kind` (audio, video, report, quiz, flashcards, mind_map, slide_deck, infographic, data_table), `artifact_id=null` (latest), `filename=null`, `file_format=null` | `{path}` inside the download folder |
| `delete_artifact` | `notebook_id`, `artifact_id`, `confirm=false` | `{deleted}` |

Download formats: audio .mp3, video .mp4, report .md, mind_map .json, infographic .png, data_table .csv, quiz/flashcards json/markdown/html, slide_deck pdf/pptx.
