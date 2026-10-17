---
name: alfred-ask
description: Answer a question the user asked from the Alfred board - from a snippet's alfred.ask() or from the ✦ menu over selected text in a card, comment or brief. Run by the board as "/alfred-ask <id>"; use it when a run says so.
argument-hint: "<ask id>"
---

# Alfred ask

Read `rules.md` in this skill's folder first. The board sent this run: the user is waiting on the snippet or the
editor, which shows your answer the moment you send it. Keep it fast - one answer, no side work.

1. `board_ask_get` with the id from the arguments: the question, where it was asked (project, cycle, card, snippet),
   its `data`, and `how` to answer. Already `ANSWERED` or `CANCELLED`: stop - say so in one line.
2. Look only as far as the question needs. A question about calls, statements or logs: read them with the usual tools
   (`problem_calls`, `investigate_call`, `db_statements`, `search_logs`, ...) scoped to the ask's project or cycle. A
   question about a card: `board_get`.
3. `board_ask_answer` with the id and the answer:
   - **From the editor** (`kind: EDITOR`): the answer replaces or follows the selected text (`data.selection`, or the
     whole `data.text` when nothing was selected). Send the new text only - no preamble, no "Here is". Write the
     board's Markdown: tables, `{red|colour}`, fences such as ```` ```chart ````, ```` ```stats ````,
     ```` ```html live ```` (a locked frame, no network: `alfred.data()` for live numbers; `board_lib` for libraries),
     and keep every `@[type:ref|label]` mention, number and code span exactly as it was. Never drop facts when asked
     to shorten; never invent numbers when asked for a chart.
   - **From a snippet** (`kind: SNIPPET`): the snippet's script receives your text as the result of `alfred.ask()`.
     Answer in plain words, or in JSON when the question or its `data` asks for data.
4. Nothing else: no cards, comments, moves or logs unless the question asked for one - then propose it in the answer
   and let the user do it.

When you cannot answer (no data, the question needs the app run), answer that in one sentence with what would let you
answer - the user sees it in place.

Work items asked about are read live (`team_item`, `team_search`); with TOKEN_MISSING answer "enter your token in the
Team tab" - never ask for the token.
