# 037 Questions form - tasks

Design: [plan.md](plan.md) (D1-D22). Files and order: [build-plan.md](build-plan.md). Mock: [mock.html](mock.html).
Each task is written test-first: the tests named in it are written and fail before the code. A task is done when its
tests pass and the "Done when" line holds. Run only the task's own tests while working; the full suites run once in
T60.

## How the code already works (read before starting)

- **Questions are text.** A question comment is `**Question** …` plus a ```` ```questions ```` JSON block
  (`backend-board/.../application/service/QuestionBlocks.java`, frontend `shared/utils/question-blocks.ts`). The
  `questions` table is only an index of it (`Question` record: `entryId`, `cardId`, `idx`, `header`, `text`, `state`,
  `parentIdx`/`parentOption` for follow-ups, `recommended`). A question's identity is **card + entry + header**.
- **Answers are text too.** `QuestionsUseCase.answer(actor, cardId, List<EntryAnswers>, clearDecision)` writes one
  `**Answers** …` comment per question comment with a ```` ```answers ```` block `{"<header>": {"chose": [labels], "other",
  "note", "later"}}` (`QuestionBlocks.answerText`), updates the index, and fires the usual change feed - which is what
  `board_changes`, `board_wait` and alfred-live read. The importer calls exactly this; it never writes the index itself.
- **New data goes into these JSON blocks as new keys** (`details` on a question; `via`, `sure` on an answer). Unknown
  keys are ignored by older readers. No new enum value, no new `Actor`, no new card column (CLAUDE.md: older Alfreds throw
  on unknown enum values).
- **Files:** `BoardFilesService` + `BoardFile.TYPES` (extension → mime, 10 MB, refuses html today),
  `BoardFilesController` (`/board/files`). **Pictures:** `BoardTextController` `POST /board/images` (png/jpeg/gif/webp),
  `GET /board/images/{id}`.
- **Tables** are created in `SqliteBoardRepository` with `CREATE TABLE IF NOT EXISTS` at start.
- **MCP:** `mcp-server/src/tools/board.ts` (`board_ask` ~L1188, `board_image` ~L1301), `tools/board-visuals.ts`
  (`board_attach`); tests in `mcp-server/test/*.test.ts`; jsdom is already a dependency.
- **Frontend:** `components/board/quick-answer/quick-answer.component.ts` renders questions with `app-markdown-view`;
  `board-view.component.ts` has the open-questions pill; `bulk-bar.component.ts` the selection bar.

---

## Phase 0 - Fixtures

### T01 Shared fixtures
- **Files:** `specs/037-questions-form/fixtures/`:
  `form-ar.html`, `form-en.html` (rendered by T13 once it exists; until then hand-copied from the mock and regenerated in
  T13), and answers files: `answers-ok.html`, `answers-later-follow.html`, `answers-wrong-form.html`,
  `answers-other-board.html`, `answers-v7.html`, `answers-big.html` (made by the test at 2.1 MB, not committed),
  `answers-no-block.html`, `answers-script-only.html`, `answers-bad-json.html`, `answers-script-around.html` (a
  `<script>alert(1)</script>` before and after a valid block), `answers-close-tag.html` (`</script>` in a name, written
  as `\u003c`), `answers-unknown-key.html`; zips: `answers-ok.zip` (the ok html inside), `answers-two-html.zip`, `answers-bomb.zip`
  (a 1 KB entry that inflates past 2 MB), `answers-encrypted.zip`, `answers-slip.zip` (an entry named `../x.html`),
  `answers-macosx.zip` (ok html + `__MACOSX/` junk, accepted); and `expected/*.json` - the parse result every parser must give.
- **Done when:** both the Java (T22) and TypeScript (T41) tests load these same files by relative path.

---

## Phase 1 - Backend (`backend-board`)

### T10 `details` on a question
- **Files:** `QuestionBlocks.java` (`Asked` gets `details`; `of()` reads it; `problem()` checks it is a string ≤ 32 KB),
  `Question.java` is untouched (details stay in the comment text, read on demand), `BoardService` / the
  `CommentOnCardUseCase` path that validates a question comment's size (the comment limit must fit a 32 KB details per
  question; raise the question-comment limit, not every comment's).
- **Tests:** `QuestionBlocksTest`: a block with `details` parses and keeps it; `details` over 32 KB is a `problem()`;
  a block without it behaves as before; `GET /board/cards/{id}/questions` returns `details`.
- **Done when:** a question asked with details round-trips through the comment text, the index and the API.

### T11 Answer source and sureness
- **Files:** `QuestionsUseCase.AnswerIn` + `via` (String ≤ 300) and `sure` (`sure|likely|unsure` or null);
  `QuestionBlocks.answerText` / `answers()` write and read them as keys of the answers block; the answer comment's first
  line says `· from answers file by <name>` when `via` is set; `QuestionsController.AnswerDto` takes both (the board UI
  sends neither).
- **Tests:** `QuestionBlocksTest` round-trip with and without the new keys; an answers block written by today's code
  still reads.
- **Done when:** an answer can carry where it came from and how sure, visible in the comment and in `board_changes`.

### T12 `question_forms` table and store
- **Files:** `SqliteBoardRepository` (table `question_forms(form_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, project
  TEXT NOT NULL, created_at TEXT NOT NULL, lang TEXT NOT NULL, title TEXT, questions TEXT NOT NULL)`, index on
  `board_id`), a port `QuestionFormsPort` (save, find, list by board) in `application/port/out`, the file-store fallback
  as an in-memory map with the same port (the slice must still work with `type=file`).
  `questions` JSON per form question: `{id, cardId, cardNumber, entryId, header, hash, options: [{id, label}],
  followUp: {id, options: [{id, label}]} | null}`; `hash` = SHA-256 of `QuestionBlocks.sameness(question)` + option labels.
- **Tests:** repository test (save, find, unknown id, list per board); the file-store variant passes the same test.
- **Done when:** a form can be stored and found by `formId` on both stores.

### T13 `QuestionsFormService` and the template
- **Files:** `application/port/in/QuestionsFormUseCase.java` (`Form build(String boardId, List<Integer> cards, String
  lang, String title, Actor actor)` → `{formId, fileName, html, questions, cards, sizeBytes, leftOut}`),
  `application/service/QuestionsFormService.java`, `resources/board/questions-form.html` (template: the mock's form -
  CSS, AR/EN strings, the form JS - with one `{{FORM_JSON}}` slot).
  Steps: resolve the board (`AB#…` / name / id through the existing board lookup); collect open questions
  (`QuestionsUseCase.questions` per card, `open(now)`, follow-ups attached to their parent option, not as their own
  question); read each question's block from its comment for why/options/description/recommended/preview/details;
  mask every text through the board mask; assign `q1…`, `o1…`, `f1…`; pick `lang` (`auto` = per-question Arabic vs
  Latin letters, majority, tie → ar); store the form (T12); write the JSON into `<script type="application/json"
  id="alfred-form">` with `<` as `\u003c`; render details (T15).
  File name `<board-slug>-questions-<yyyy-mm-dd>.html`; title default "أسئلة <board name>" / "Questions: <board name>".
- **Tests:** `QuestionsFormServiceTest`: 3 cards with open questions → ≥ 3 questions with ids and keys; `cards` filter
  (one, several, one with none → named in `leftOut`); answered and withdrawn questions are not included; follow-up
  under its option; Arabic → `dir="rtl" lang="ar"`, English → LTR; no `http` in any `src`/`href` (jsoup over the
  output); a masked header value in a question does not appear; `then` never appears; `</script>` in a question cannot
  close the data block. Regenerate `fixtures/form-*.html` from this test (a flag), then T01's expected files.
- **Done when:** the service builds the same form the mock shows, from real board data.

### T14 Endpoint: build a form
- **Files:** `adapter/in/web/QuestionsFormController.java`: `POST /board/boards/{id}/questions-form` body `{cards?,
  lang?, title?}` → `200` with the html, `Content-Type: text/html; charset=utf-8`, `Content-Disposition: attachment;
  filename=…`, headers `X-Alfred-Form-Id`, `X-Alfred-Form-Questions`, `X-Alfred-Form-Left-Out` (JSON, URL-encoded).
  Body also takes `format: "html" | "zip"` (default html): zip → `application/zip`, `<slug>-questions-<date>.zip`
  holding the one html (`java.util.zip.ZipOutputStream`, DEFLATED), and header `X-Alfred-Form-Size` (bytes of the html)
  plus `X-Alfred-Form-Warning` over 10 MB. `409 NO_OPEN_QUESTIONS` when there are none. Allowed for Claude and the user; reads only, but it stores a form, so it
  is a write for the edit-access rule (`ALFRED_SETTINGS_EDIT_FROM` / tunnel read-only, as other board writes).
- **Tests:** controller test (headers, 409, 404 board; zip holds exactly the html, unzipped bytes equal the html
  response; warning header over 10 MB); `BoardWriteTargets` maps it to its board (T30).
- **Done when:** `curl -X POST …/questions-form` saves a working form.

### T15 Details made static for the form
- **Files:** `application/service/FormDetailsRenderer.java`. Input: a question's details text. Output: safe static HTML.
  Pictures `![alt](/board/images/<id>)` → `<img src="data:…">` from `BoardImagesUseCase`, scaled to ≤ 1600 px wide
  (`javax.imageio`), JPEG q=0.82 when the PNG is over 300 KB; `chart` / `stats` blocks → inline SVG / HTML (bar and line
  only; anything else → the block's data as a table); `calls` blocks and call mentions → a masked table (method, path,
  status, ms) through the existing call lookup; spec/card mentions → their label; file links → their name;
  `html live` / `python live` → "Open on the board to see this" and the item goes into `leftOut`. Everything else goes
  through `RichText` (the board's sanitiser) - no `<script>`, no `on*`, no external URL survives.
- **Tests:** `FormDetailsRendererTest`: picture → `data:image/…`; big picture scaled; chart → `<svg`; calls → table with
  masked values; live snippet → note + leftOut; `<img src="http://…">` and `<a href="https://…">` in details are dropped
  or made text; total size reported.
- **Done when:** a question with every kind of detail renders offline with no network request.

### T20 `AnswersImportService` - parse
- **Files:** `application/port/in/AnswersImportUseCase.java`, `application/service/AnswersFile.java` (pure parser):
  `parse(byte[]) → Parsed | Refusal`. Size ≤ 2 MB before parsing; jsoup `Jsoup.parse(String)` (no script execution
  exists in jsoup); `doc.getElementById("alfred-answers")`, must be a `<script type="application/json">`; Jackson
  `readTree` of its `data()`; schema: `formId` string, `version == 1`, `answers` array of `{q: string, choice: [string],
  other: bool, later: bool, note: string ≤ 16 KB, sure: enum|null, follow: {q, choice}|null}`, `answeredBy`/`role` ≤ 200,
  `answeredAt` ISO instant. Refusal messages exactly as plan.md D17.
  Zip: `AnswersFile.unzip(byte[])` before parse - `java.util.zip.ZipInputStream`, skip directories and `__MACOSX/`,
  exactly one `*.html`, refuse an encrypted entry (general-purpose flag bit 0) and a name with `..` or a leading `/`,
  read through a counting stream capped at 2 MB (stop and refuse at the cap - never trust the declared size).
- **Tests:** `AnswersFileTest` over every fixture (html and zip): expected JSON or the expected refusal; `answers-script-around` parses
  and nothing runs; `answers-close-tag` keeps the name.
- **Done when:** every fixture gives `fixtures/expected/*`.

### T21 `AnswersImportService` - check and report
- **Files:** `AnswersImportService.importAnswers(String boardId, Parsed, boolean dryRun, Actor, String askedIn)` →
  `{file: {formId, board, answeredBy, role, answeredAt, lang}, rows: [{q, card, header, question, choice: [{id, label}],
  other, later, note, sure, follow, result}], applied, summary}`.
  Checks: form exists (T12) else "This answers file was not made by this Alfred"; `form.board_id == boardId` else
  "This answers file belongs to <board ref>"; per answer: unknown `q` or option id → `UNKNOWN_KEY`; question no longer
  in the index, closed, withdrawn, or its hash differs → `CHANGED` ("question withdrawn or changed"); already answered
  on the board (index state not OPEN/LATER-due, or an answer entry exists) → `ALREADY_ANSWERED`; `later` → `LATER`; no
  choice/other/note → `NOT_ANSWERED`; else `APPLY`.
- **Tests:** `AnswersImportServiceTest`: wrong formId, other board, unknown key, withdrawn, edited option label → changed,
  already answered, later, not answered, follow-up resolved to its labels.
- **Done when:** the dry-run report matches the mock's tab 4 rows for the same data.

### T22 Apply
- **Files:** same service. With `dryRun == false`: group `APPLY` rows by card and question entry, map option ids →
  labels (and the follow-up's under its own header), build `AnswerIn(chose, other ? note : null, other ? null : note,
  null, via, sure)` with `via = "answers file by <answeredBy> (<role>), <answeredAt>"`, call `QuestionsUseCase.answer(
  Actor.USER, cardId, entries, false)` once per card. `LATER` rows: one comment on the card "<answeredBy>: later - <note>"
  as the user, question left open. `dryRun=false` from Claude (`X-Alfred-Actor: claude`) needs `askedIn` that names a USER
  chat message on this board or `"terminal"` - same check as `ManageBoardsUseCase.askedBy`; else `403 ASK_THE_USER`.
- **Tests:** apply records the answers as the user with `via` and `sure`, the change feed carries the answers block,
  Needs decision clears when the last open question is answered; second import → every row `ALREADY_ANSWERED`, nothing
  written; Claude without `askedIn` refused; Claude with a user chat message id accepted.
- **Done when:** importing `answers-ok.html` lands the answers on their cards exactly like answering on the board.

### T23 Endpoint: import
- **Files:** `AnswersImportController.java`: `POST /board/boards/{id}/answers-import` body `{fileId? | text? | answers?
  (already-extracted JSON from the MCP server), dryRun = true, askedIn?}`. `fileId` reads the stored file (T24). `text`
  is the whole html. `answers` is checked with the same schema as T20.
- **Tests:** controller test for each input form and each refusal; `dryRun` default true.
- **Done when:** the board and the MCP tool can both call it.

### T24 Upload, store and serve the answers file
- **Files:** `BoardFile.TYPES` + `"html" → "text/html"` and `"zip" → "application/zip"`, both behind the answers check; `BoardFilesService.upload`: an `.html` must pass
  `AnswersFile.parse` (else "An HTML file is accepted only as an Alfred answers file"), a `.zip` must pass
  `unzip` + `parse` (else "A .zip is accepted only when it holds one Alfred answers file"); stored as other files.
  `BoardFilesController` `GET /board/files/{id}` for html and zip: `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename=…`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`.
  New `GET /board/files/{id}/answers.json` → the T21 report with `dryRun` semantics (no write), board taken from the form.
- **Tests:** html that is not an answers file → 400 with the message; a zip with any other content → 400; an answers
  zip → stored and `answers.json` reads the html inside; answers file → stored; GET headers exactly as
  above; `answers.json` returns the joined JSON; a non-html file's GET is unchanged.
- **Done when:** an answers file can sit on a card or the chat and never open inline.

---

## Phase 2 - Backend wiring (`backend-app`)

### T30 Board lock and streams
- **Files:** `boardbridge/BoardWriteTargets` - `questions-form` and `answers-import` map to the board in the path;
  `linksbridge/StreamRoutes` - `GET /board/files/{id}/answers.json` into `NEVER` (forms are this Alfred's own in v1).
- **Tests:** `BoardLockInterceptorTest` (held board: import from a non-holder → 409 HELD), `StreamRoutesTest` green.
- **Done when:** a held board refuses another user's import; the routes test passes.

### T31 Board export / import
- **Files:** none, by decision: `question_forms` is not exported (a form belongs to the Alfred that issued it). Add one
  line to `docs/board.md` saying so. `details`, `via` and `sure` travel inside the comment text, which export already
  carries.
- **Tests:** existing board export test: a question with details and an answer with via survive export → import.
- **Done when:** that test passes unchanged in code.

---

## Phase 3 - MCP server

### T40 `details` on `board_ask`, and `board_image_put`
- **Files:** `mcp-server/src/tools/board.ts` - `board_ask` question schema + `details` (string ≤ 65536, described as in
  plan.md D11), passed into the questions block; `board_ask_get` / `board_get` output keep it. New `board_image_put`
  `{path? | base64?, name, number?, project?}`: read the file (≤ 10 MB), check magic bytes (PNG `89 50 4E 47`, JPEG
  `FF D8 FF`, GIF `47 49 46 38`, WebP `RIFF….WEBP`), POST to `/board/images`, return `/board/images/<id>` and
  `![name](/board/images/<id>)`, with the line "Pictures are not masked: check no secret is on screen."
  `tools/board-visuals.ts` - `board_attach` + `path`.
- **Tests:** `board-rich.test.ts`: details pass through; `board_image_put` refuses a text file named .png; path and
  base64 both work against the test server.
- **Done when:** Claude can ask a question with a screenshot it took.

### T41 `answers-file.ts`
- **Files:** `mcp-server/src/answers-file.ts`: `extractAnswers(html: string)` - same limits and messages as T20; `unzipAnswers(bytes)` - the same zip rules, with
  Node's `zlib.inflateRawSync` over the central directory (no new dependency; `maxOutputLength` = 2 MB so a bomb throws); jsdom
  `new JSDOM(html)` with default options (scripts never run, no resources loaded), `getElementById('alfred-answers')`,
  `JSON.parse`, the same schema (zod).
- **Tests:** `answers-file.test.ts` over every fixture → `fixtures/expected/*`.
- **Done when:** TypeScript and Java give identical results for every fixture.

### T42 `board_questions_form` and `board_import_answers`
- **Files:** `tools/board.ts`. `board_questions_form {board, cards?, lang?, title?, format?: "html"|"zip"}` → POST T14, write the file into
  the session export folder (`session_settings` export path), return path, question count, cards, size, what was left
  out. `board_import_answers {path? | fileId? | text?, board?, dryRun = true, askedIn?, attach?}` → path: read (`.zip` → `unzipAnswers` first), T41,
  send `answers`; text: T41 then send; fileId: send as is. `board` defaults to the form's board from the file.
  `attach: true` uploads the file to the board chat first. Returns the report as a table plus the JSON. Descriptions
  in the style of the others: what it does, what Claude may do alone (form, dry run), what needs the user (apply).
- **Tests:** `board-writes.test.ts`: form saved to the export folder; import dry run; `dryRun:false` without `askedIn`
  refused before any request; with it the request carries `askedIn`.
- **Done when:** the terminal flow in the demo (step 12) works.

### T43 Docs for the tools
- **Files:** `docs/mcp.md` - the four tool changes in the board tools list.

---

## Phase 4 - Frontend

### T50 API and models
- **Files:** `core/services/board-api.service.ts` - `questionsForm(boardId, {cards, lang, title}) : Observable<Blob +
  meta>`, `importAnswers(boardId, {fileId|text, dryRun})`, `answersJson(fileId)`; `core/models/board.models.ts` - the
  report types; `shared/utils/question-blocks.ts` - `details` on a question, `via`/`sure` on an answer.
- **Tests:** `question-blocks.spec.ts` (details, via, sure parse; old blocks unchanged).

### T51 The form template's script
- **Files:** none new - tests over `backend/backend-board/src/main/resources/board/questions-form.html` loaded as text.
- **Tests:** `frontend/src/app/shared/utils/questions-form-template.spec.ts`: inject `fixtures/form-ar.html` into a
  sandboxed document, drive it: pick, other + note, later, follow-up visibility, multi-select, Accept all recommended,
  Only unanswered, language switch flips `dir`, download produces html whose `#alfred-answers` equals the expected JSON,
  `</script>` in a note survives; "as .zip" produces a zip that `java.util.zip` and `unzipAnswers` both open and whose
  html is byte-equal to the plain download. This is the round-trip test's middle half (T13 renders, this fills, T20 parses).
- **Done when:** render → fill → parse equals the input JSON.

### T52 Details on the board
- **Files:** `quick-answer.component.ts` (+ its template/styles in `styles.scss`): a `<details>` "Details · 1 screenshot ·
  1 chart · …" (counts from the text: pictures, fenced blocks, mentions) under the question, collapsed; rendered with
  `app-markdown-view`. `card-peek.component.ts`: a "Details" marker only.
- **Tests:** component spec: details shown and counted; absent when none.

### T53 Export buttons
- **Files:** `board-view.component.ts` - the "❓ N open questions on M cards" pill opens a menu (Questions form, Show the
  cards, Upload answers file…), closing on outside click / Escape like the other board menus; the card's question strip
  in `quick-answer.component.ts` - "⇩ Form"; the card ▾ menu - "⇩ Questions form (n)", "⇧ Upload answers file…";
  `bulk-bar.component.ts` - "⇩ Questions form (n)" when any selected card has an open question, a toast naming skipped
  cards. Language: a small choice in the pill menu (Auto / English / العربية), and the file type (.html / .zip), both
  remembered per board in localStorage (try/catch); the card and bulk actions use the same remembered choices. A
  warning toast with the size when the response carries `X-Alfred-Form-Warning`. All save through the browser's download.
- **Tests:** specs: pill menu items; strip button only with open questions; bulk action hidden with none, count is
  questions; the request carries the right cards.

### T54 Upload and report
- **Files:** `components/board/answers-import/answers-import.component.ts` (new): takes a File or a fileId, calls
  `importAnswers(dryRun: true)`, shows the report table (card, question, answer with labels, note, sure, result pill),
  the file's who/when, Apply (n) → `dryRun: false`, then a toast and the cards refresh by the usual socket signal.
  Used from: the pill menu's Upload (file picker, `.html,.zip`), the board chat's 📎 and drop (an `.html` or a `.zip` goes here
  instead of the plain attach), a card's ▾ menu and a drop on the card. The file is stored (T24) and shown as a download chip only.
- **Tests:** spec: report from JSON; Apply sends dryRun false; a refusal shows its message; **no uploaded html is ever
  bound to `[innerHTML]`, an iframe or `bypassSecurityTrust*`** (a test greps the component and the chat's attachment
  rendering for those, like `snippet-security.spec.ts`).

---

## Phase 5 - Skills and docs

### T55 Skills
- **Files:** `skills/_shared/rules.md` - section "Asking well" (plan.md D21, the text in mock tab 7) and the
  form/import line; `skills/alfred-setup`, `alfred-triage`, `alfred-live`, `alfred-listen`, `alfred-review`,
  `alfred-verify` `SKILL.md` - one line each pointing to it.
- **Tests:** `tests/python/test_alfred_skill.py` (tool names exist), `mcp-server/test/board-skills.test.ts`.

### T56 Docs
- **Files:** `docs/board.md` - "Questions form" (export, form, answers file, upload, import rules, the file is a download
  only, forms not exported) and "Details on questions"; `docs/mcp.md` (T43); `CLAUDE.md` - one bullet in Non-obvious
  rules: "Questions form (specs/037): Alfred renders it; the answers file is HTML both ways and is read only through
  `#alfred-answers` by a parser, never shown inline; answers apply through `QuestionsUseCase.answer` as the user, and
  Claude applies only with `askedIn`."

---

## Phase 6 - Finish

### T60 Full suites and build
- Backend `mvn test` in the Docker JDK 21 image (repo root mounted); frontend `npm test && npm run build`; mcp-server
  tests; `pytest tests/python`; `docker compose build backend` and a start, then the demo checklist in build-plan.md
  end to end on the running stack, screenshots of each step.

## Dependencies

T01 → T13, T20, T41 · T10 → T13, T15, T40, T52 · T11 → T22 · T12 → T13, T21 · T13 → T14, T51 · T15 → T13 (details
part) · T20 → T21 → T22 → T23 → T24, T54 · T41 → T42 · T50 → T52, T53, T54 · all → T55, T56 → T60.
Order of work: T01, T10, T11, T12, T13, T15, T14, T20-T24, T30, T31, T40-T43, T50-T54, T55, T56, T60.
