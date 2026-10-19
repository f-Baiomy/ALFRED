# specs/037 - Questions form: board questions answered offline, with their evidence

Mock: `mock.html` (7 tabs). Status: mock agreed in chat (2026-10-19), not started.

## The problem

Claude's questions on a board (`board_ask`) can be answered only by someone who has Alfred open. Many answers belong
to people outside it - a BA, a product owner, another team - who get the question pasted into Teams or mail, lose the
options and the evidence on the way, and answer in a reply that someone has to carry back to the card by hand. The
reference form `knowledge-base-questions.html` showed the shape that works: one HTML file, opened offline, every
question with its options and a recommended one, a note box, and a file to send back. It was written by hand, its
answers came back as JSON nobody could read, and nothing put them back on the cards.

Questions also lack evidence. `why` is one line (2000 characters) and Claude cannot add a picture, so the person
answering does not see the screen, the call, the rows or the spec line that made Claude ask.

## The idea

Alfred builds the questions form itself, from the open questions on the board, one card or a selection. The person
answers in a browser, offline, and downloads an **answers file that is HTML too**: a read-only page in the same design
with a machine block inside. Anyone uploads it back - on the board or through Claude - and Alfred puts each answer on
its question exactly as if it was picked on the board. Questions carry **details**: screenshots, charts, tables,
calls and spec lines, shown on the board and embedded in the form.

## Decisions

**The form**

- **D1 Alfred renders the form.** One renderer in `backend-board` for every caller: the board buttons and the MCP tool
  `board_questions_form`, which only passes board, cards and language and saves the returned file. The look is the
  reference form's: cards, option rows, the "(recommended)" marker, "Other answer" with notes, sticky bottom bar with
  progress, dark mode by `prefers-color-scheme`.
- **D2 Three ways to export.** The board summary pill "❓ N open questions on M cards" becomes a menu (Questions form for
  all, Show the cards, Upload answers file). A card with open questions has "⇩ Form" on its question strip and in its ▾
  menu. The selection bar gets "⇩ Questions form (n)" when a selected card has an open question; cards without one are
  skipped and named.
- **D3 One self-contained file.** CSS, JS and data inline; no `src`/`href` to the network; no font, no CDN. The data is
  `<script type="application/json" id="alfred-form">`. File name `<board>-questions-<date>.html`. Pictures and
  charts are inside it too (D13): one file to send, whatever the questions hold.
- **D3a Or the same file in a .zip.** Some company mail systems block or quarantine `.html` attachments. Every
  "Questions form" action offers **.html** (default) or **.zip**: a zip holding that one html, nothing else, made by
  Alfred (`<board>-questions-<date>.zip`). Mail filters pass a zip; the reader opens the html inside. The choice is
  remembered per board. A form over 10 MB gets a warning with its size and the advice to send it through Teams or
  SharePoint.
- **D4 Ids, not labels.** Every question has an id (`q1`…) and every option an id (`o1`…; follow-up options `f1`…). Alfred
  stores the form under its `formId` (D17), so an answer that names `q3` + `o1,o3` means exactly one thing, whatever
  the file's text says.
- **D5 Arabic and English, direction automatic.** UI strings in both. The form starts in the language most questions
  are written in (per question: Arabic letters vs Latin letters; a board may force `ar`/`en`), the reader switches
  with ع / EN and the choice is remembered. Page direction follows the UI language; every text the board wrote
  (questions, options, details, notes, names) is `dir="auto"`, names in `<bdi>`, so an English question in an Arabic
  form reads left to right.
- **D6 Grouped by card.** A card header (number, short name, type, answered n/m), a sticky strip of card chips to jump,
  and a progress bar.
- **D7 What a question offers.** Its options (radio, or checkboxes when `multiSelect`), "Other answer" (its text is the
  note), and **"Not sure, ask me later"**. A question with no options is a free question: the note is the answer. An
  option's `followUp` opens under it when picked. An optional **"How sure are you?"** (sure / likely / not sure). An
  option's `preview` shows as "Why is this recommended?" (collapsed). `then` is never shipped.
- **D8 Helpers.** Only unanswered, Accept all recommended (asks first, fills follow-ups' recommended too), Next
  unanswered, keys 1-6 to pick and N for next, print-friendly.
- **D9 Autosave in the browser, never required.** localStorage keyed by `formId`, every access in try/catch; the bar says
  "Saved on this device · 14:02" or "This browser does not save: download your answers before closing".
- **D10 Masked.** Question text, details and option text go through the board's mask before they reach the file; no
  variable values, no secrets.

**Details on questions**

- **D11 `details` on a question**, a new key of the question in the comment's `questions` block (the text stays the source of truth). Board text (Markdown, HTML only when Markdown cannot say it), up to 32 KB (as built: the comment limit leaves room for 32 KB per question): pictures
  `![…](/board/images/<id>)`, `chart`, `stats`, `calls`, tables, call/spec mentions, file links. `why` stays
  the one-line reason; option `preview` stays per-option detail. Shown on the board under the question (collapsed,
  "Details · 1 screenshot · 1 chart · …"), returned by `board_ask_get` / `board_get`.
- **D12 Claude can add pictures.** New MCP tool `board_image_put {path | base64, name, number?}` posts to the existing
  `POST /board/images` and returns `/board/images/<id>`. PNG / JPEG / GIF / WebP, at most 5 MB (as built), checked by magic
  bytes. Pictures cannot be masked: the tool says so, and the rules tell Claude to crop or blur first. `board_attach`
  also takes `path`.
- **D13 Details in the offline form are static.** Alfred embeds pictures as `data:` (scaled to 1600 px), draws
  `chart`/`stats` as inline SVG/HTML, turns `calls` and call mentions into a masked table (method, path, status, time),
  and file links into their name. Live snippets (`html live`, `python live`) are not run: the form says "open on the
  board", and Claude adds a picture when it matters. The tool result names what was left out and the file size.

**The answers file**

- **D14 HTML, both ways.** "Download answers" saves `<board>-answers-<date>.html`: a read-only page in the same design and
  the reader's UI language - a summary (answered, later, not answered, not the recommended), each question with the
  chosen option highlighted and tagged "As recommended" / "Not the recommended", the follow-up answer, the note, how
  sure, and the other options folded in `<details>`. No inputs, no script that runs on open. It does not carry the
  details (it stays small). The form offers **Download answers** (.html) and **as .zip** next to it, for the
  same mail filters; the zip is written by the form's own script (stored, no compression, a CRC32 - no library, still
  offline).
- **D15 The machine block** `<script type="application/json" id="alfred-answers">`:
  `{formId, version: 1, board, lang, answeredBy, role, answeredAt, answers: [{q, choice: [optionIds], other, later,
  note, sure, follow: {q, choice} | null}]}`, with `<` written as `\u003c` so no text can close the script. Download
  warns about unanswered questions and "Other answer" without a note.

**Upload and import**

- **D16 Where it goes in.** The pill menu, the board chat (📎 or drop), a card's ▾ menu or a drop on the card. Wherever it
  lands, it answers the questions it names (a file dropped on #97 that also answers #88 applies to both, and says so).
- **D16a A .zip is opened first.** An uploaded `.zip` (board or Claude) is accepted when it holds exactly one `.html`
  entry (folders and `__MACOSX` junk ignored), its compressed size ≤ 2 MB and its uncompressed size ≤ 2 MB (read with a
  counting stream that stops at the limit, so a zip bomb never expands), no encryption, no path outside the archive.
  The html inside then goes through D17 as if uploaded alone. Anything else: "A .zip is accepted only when it holds
  one Alfred answers file". The stored file is the zip as uploaded.
- **D17 Alfred checks before anything happens.** A real HTML parser reads only `#alfred-answers` with a JSON parser - no
  script runs, nothing is evaluated. Refused whole: over 2 MB, no block or not JSON ("Not an Alfred answers file"),
  unknown `version`, a `formId` Alfred did not issue, or one issued for another board ("belongs to AB#61813"). Then per
  answer: **will apply**, **already answered** (any answer on the board for that question, even a different one - a file
  never overwrites), **question withdrawn or changed** (closed, withdrawn, or its text/options differ from the stored
  hash), **unknown key**, **later** / **not answered** (stays open).
- **D18 Dry run first, Apply by the user.** The preview is built from the parsed JSON, never from the file. Apply on the
  board, or Claude with `dryRun: false` and `askedIn` naming a user chat message or "terminal" (the same rule as
  `board_open`). Each answer is recorded on its card as the user's, with the source "answers file by Ahmed Ghonim
  (BA), 2026-10-19 14:02" and how sure (new keys `via` and `sure` in the `answers` block, through `QuestionsUseCase.answer`), so `board_changes` / `board_wait` / alfred-live see an ordinary answers block.
  "Later" answers put a "Ahmed: later" note on the question and leave it open.
- **D19 The file is kept as a download only.** `POST /board/files` accepts `.html` (and `.zip`, D16a) only when it
  parses as an answers file. It is served with `Content-Disposition: attachment`, `Content-Type: application/octet-stream`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, and never shown inline anywhere on the
  board. `GET /board/files/{id}/answers.json` returns the parsed JSON joined with the stored questions (card, question
  text, chosen labels beside the ids).
- **D20 Claude's path.** `board_import_answers {path | fileId | text, board?, dryRun = true, askedIn?, attach?}`. With a
  path (`.html` or `.zip`, same D16a rules) the MCP server reads the file, extracts the block itself (jsdom, scripts off, same limits) and sends only the
  JSON to Alfred, which checks it again. `attach: true` also puts the file on the board chat. It returns Alfred's joined
  JSON and the report.

**Skills**

- **D21 "Asking well" in `skills/_shared/rules.md`.** A question stands on its own for someone who was not there:
  question = the decision in one line, why = what it blocks, details = the evidence in order (what the user sees as a
  marked screenshot; what happened as calls and rows; how much as stats/chart from real numbers; what the spec says,
  quoted with ids), every option with `then` and `preview`, one `recommended` with its reason, no secrets in text or on a
  picture. Questions for someone outside Alfred → `board_questions_form`; an uploaded answers file →
  `board_import_answers`.
- **D22** `alfred-setup`, `alfred-triage`, `alfred-live`, `alfred-listen`, `alfred-review`, `alfred-verify` point to that
  section in one line each. Claude may make a form and dry-run an import on its own; applying needs the user (D18).

## Not in v1

Answers carrying their own pictures; a form answered by several people merged into one file; sending the form from
Alfred by mail; streamed boards (another Alfred's questions) - the form is built by the board's own Alfred.

## As built (2026-10-19)

- `details` is at most 32 KB per question or follow-up; `board_image_put` takes at most 5 MB.
- Live blocks in `details` (```` ```calls ````, snippets, timelines) are not frozen into the form: they become a short
  note ("shown live on the board") and are listed in the form's left-out line.
- Forms are not part of the board export; the tunnel stays read-only, so answers are never applied through it.
