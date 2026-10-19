# 037 Questions form - build plan

The design is in [plan.md](plan.md) (D1-D22) and [mock.html](mock.html). This file says how to build it; the task-by-task
breakdown with files, tests and dependencies is [tasks.md](tasks.md).

## Research outcomes

- **R1** `backend-board` already depends on jsoup (`RichText`), and `mcp-server` on jsdom: both parse HTML without
  running scripts. No new dependency.
- **R2** `POST /board/images` already takes png/jpeg/gif/webp (`BoardTextController`); `board_image_put` only needs the
  MCP tool.
- **R3** Question rendering on the board already goes through `app-markdown-view` (`quick-answer.component.ts`), so
  `details` renders pictures, blocks and mentions with no new renderer.
- **R4** `BoardFilesService` refuses html today ("A file is one of: csv, har, jpeg, …"); the answers file is the one
  html it will accept.
- **R5** Every route is under `/board`: no gateway regex or `SpaPageFilter` change. No new Maven module: no Dockerfile
  `COPY` line.

## Files

**Backend - `backend-board`**

| File | Change |
|---|---|
| `domain/model/Question.java`, `Ask.java` | `details` (≤ 32 KB board text), carried through store, JSON and export |
| `application/service/QuestionsFormService.java` (new) | collect open questions (board / cards), mask, ids, language, store the form, render |
| `application/service/FormDetailsRenderer.java` (new) | details → static HTML: pictures to `data:` (scaled), chart/stats to SVG/HTML, calls to a masked table, live snippets to a note |
| `resources/board/questions-form.html` (new) | the form template (reference design, AR/EN strings, the form JS, its tiny stored-zip writer) |
| `application/service/AnswersImportService.java` (new) | parse (jsoup, `#alfred-answers` only), limits, schema, formId, per-answer report, apply through the existing answer path as the user with a source |
| `adapter/out/sqlite` + migration | table `question_forms` (form_id, board_id, created_at, lang, questions JSON with per-question hash) |
| `application/service/BoardFilesService.java` | accept html only when it is an answers file; attachment-only headers |
| `adapter/in/web` controller | `POST /board/boards/{id}/questions-form`, `POST /board/boards/{id}/answers-import`, `GET /board/files/{id}/answers.json` |

**Backend - `backend-app`**

| File | Change |
|---|---|
| `boardbridge/BoardWriteTargets` | map `answers-import` (dryRun false) to its board for `BoardLockInterceptor` |
| `linksbridge/StreamRoutes` | `answers.json` and `questions-form` into `NEVER` (not streamed in v1) |

**Frontend**

| File | Change |
|---|---|
| `components/board/board-view/board-view.component.ts` | open-questions pill → menu (form for all, show cards, upload) |
| `components/board/quick-answer/quick-answer.component.ts` | "⇩ Form" on the strip; Details block (collapsed, counted) |
| card ▾ menu (board-card) | Questions form, Upload answers |
| `components/board/bulk-bar/bulk-bar.component.ts` | "⇩ Questions form (n)" |
| board chat attach / drop, card drop | accept the answers html, show the report preview from JSON, Apply |
| `components/board/answers-import/` (new) | the report table + Apply, shared by chat, card and pill |
| `core/services/board-api.service.ts` | the three calls |

**MCP server - `mcp-server/src/tools/board.ts`**

`board_ask` (+`details`), `board_image_put` (new), `board_attach` (+`path`), `board_questions_form` (new),
`board_import_answers` (new, jsdom extraction, `askedIn` required for `dryRun:false`). `src/answers-file.ts` (new) holds
the extraction.

**Skills, docs**

`skills/_shared/rules.md` ("Asking well"), one line in six skills, `docs/board.md` ("Questions form", "Details on
questions"), `docs/mcp.md` (tools), `CLAUDE.md` (one bullet).

## Order of work

1. Shared test files in `specs/037-questions-form/fixtures/`: a form, answers files (good, wrong formId, other board,
   version 7, 2.1 MB, no block, script only, `</script>` in a name, unknown key, later, follow-up).
2. Backend tests first (below), then `question_forms` + `QuestionsFormService` + template, then `AnswersImportService`,
   then files/headers, then `details` + `FormDetailsRenderer`.
3. MCP tools with their tests.
4. Frontend: Details on questions, pill menu, card actions, bulk action, upload + report.
5. Skills and docs.
6. Full suites once: `mvn test` (Docker JDK 21), `npm test && npm run build`, mcp-server tests, `pytest tests/python`;
   `docker compose build backend`.

## Tests

**Backend**
- A board with open questions on 3 cards → the form holds ≥ 3 questions with ids and keys, `dir="rtl"` / `lang="ar"`
  for Arabic questions, LTR for English, and no `http` in any `src` or `href`.
- Cards filter: one card, several cards, a card with none skipped.
- Masking: a masked header value in a question's text does not reach the file.
- Details: a picture is embedded as `data:`, a `chart` block becomes SVG, a `calls` block a table, a live snippet a
  note; the file makes no network request.
- Round trip: render → fill (the form's collect/serialize run in the frontend spec with the same template) → answers
  html → import `dryRun` → the JSON equals the input.
- Rejects: wrong formId, another board's formId, unknown version, > 2 MB, no `#alfred-answers`, script-only file; a
  file with `<script>alert</script>` around the block runs nothing and parses the block.
- Apply: answers recorded as the user with the source; a second import → "already answered"; a withdrawn question →
  "question withdrawn or changed"; an edited option label → changed; later → open with a note.
- Upload: an html that is not an answers file is refused; an answers file is served with `Content-Disposition:
  attachment`, `application/octet-stream`, `nosniff`, `sandbox`.
- `StreamRoutesTest`, ArchUnit and `BoardLockInterceptor` tests stay green.

**Frontend**
- The form template's script: collect/serialize, language detect, direction, Only unanswered, Accept all recommended,
  follow-up visibility, `</script>` in a note.
- Pill menu, card "⇩ Form", bulk action shown only with open questions.
- The report is built from JSON; no uploaded html is ever bound to `innerHTML` or an iframe.

**MCP**
- `board_import_answers` extracts from every fixture like the backend does; `dryRun:false` without `askedIn` is
  refused; `board_image_put` refuses a non-image by magic bytes.
- `tests/python/test_alfred_skill.py`: the new tool names exist.

## Demo checklist

1. Open AB#62565. The pill says "❓ 7 open questions on 6 cards". Open its menu → Questions form → the file downloads.
   Switch the file type to .zip and download again: a zip with the same html inside.
2. On #97, "⇩ Form" downloads a form with only its question. Select #96 and #90 → "⇩ Questions form (2)".
3. Ask Claude to add a screenshot and the rows to a question: it uploads with `board_image_put` and asks with
   `details`. The board shows Details · 1 screenshot · 1 table.
4. Unplug the network. Open the form from Downloads: Arabic, right to left; the English question reads left to right;
   the screenshot and table show. Switch to EN: the page turns left to right.
5. Answer: pick, "Other answer" with a note, "ask me later" on one, a follow-up, "How sure". Close the tab and reopen:
   answers are still there.
6. Download answers → warning for the open one → `AB62565-answers-<date>.html`. Open it: read-only, summary on top,
   "Not the recommended" where it differs.
7. Back on the board, drop the file on the chat (then, once, the .zip from "as .zip") → the report: will apply / later / not answered. Apply.
8. The cards show the answers as yours, "from answers file by …". alfred-live reacts on the cards.
9. Drop the same file again → every row "already answered".
10. Withdraw a question, export, answer, import → that row "question withdrawn or changed".
11. Drop a renamed `.html` page that is not an answers file → refused. Open the stored answers file's link → it
    downloads, never opens in the board.
12. In the terminal: "import C:\Users\me\Downloads\AB62565-answers-….html" → Claude shows the dry run and asks; on yes
    it applies.

## Risks

- **Form size with pictures.** Ten 1600 px screenshots ≈ 5-8 MB: fine offline, heavy in mail. The tool result says the
  size; pictures are scaled and JPEG-compressed above 300 KB.
- **The template's JS is tested outside Angular.** The frontend spec loads the template file itself, so the backend
  and the test use one copy.
- **Two parsers (Java, TypeScript).** Same fixtures, same expected results in both test suites; Alfred checks again
  whatever the MCP server sent.
