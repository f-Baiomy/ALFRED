# Using Alfred from Claude (MCP)

Lets Claude Code, opened in the project Alfred records (e.g. odeysys), read what Alfred captured - session cycles,
inbound and outbound calls with their bodies, database statements, findings and call chains - and write back:
comments on calls, new cycles, copied calls, spacers, recording on/off, and export files. The typical session:

> "Debug the cycle 'booking fails at payment'."

Claude reads the cycle as a story (calls in run order, spacers, comments, each captured call's database summary
line and findings), opens the odeysys files named in a statement's call chain (`SystemSettingService.java:75`),
proposes the fix and records what it found as a 🤖 comment on the call, visible in Alfred's UI.

Spec, plan and tool contract: `specs/007-alfred-mcp-server/`.

## How it works

```
Claude Code (any project) ──stdio──► mcp-server (node + tsx, local process) ──HTTP──► Alfred gateway :3000 ──► backend
                                        │
                                        └── imports frontend/src/app/shared/utils (findings, exports, masking, spacer layout)
```

- **Local stdio only.** Claude Code starts the server as a child process; it opens no port, runs in no container,
  and talks only to `ALFRED_URL` (default `http://localhost:3000`). Nothing in Alfred changed for it: no new endpoint,
  service or gateway rule - it calls the same API the Angular UI calls.
- **One implementation.** The database summary line and findings (`db-findings.ts`, `db-analysis.ts`), the export
  builders, Redactions masking (`redact.ts`) and spacer placement (`spacer-gap-controller.ts`) are imported from the
  frontend, not re-written, so Claude, the UI and the exported files never disagree. All imports go through
  `mcp-server/src/frontend.ts`; a frontend rename breaks that one file and `npm run typecheck`. The export dialog's
  "build the file" step lives in `shared/utils/export-build.ts` so the UI and the server share it (masking included).
- **No polling.** Every tool fetches on demand.
- **Sized for a conversation.** A reply stays under 16,000 characters. Nothing is cut silently: lists return
  `nextOffset`, bodies and SQL return a chunk with `totalLength` and `nextOffset`, long comments are previewed with
  how to read them in full.

## Install and register (once)

Prerequisites: Alfred running (`python3 start.py`), Node 22+, and `frontend/node_modules` installed
(`cd frontend && npm ci`) - the server imports the frontend's utils, which resolve `@angular/core`/`rxjs` there.

One command does it all - installs what is missing, registers (replacing an older registration), and starts the
server once over stdio to prove it answers:

```bash
python setup_mcp.py
```

Options: `--scope project --project-dir C:/projects/odeysys` (writes that repo's `.mcp.json`), `--scope local
--project-dir …` (only you, only there), `--alfred-url http://host:3000`, `--mask`, `--source-root <folder>` (where call-chain
frames are looked up; by default the folder Claude Code is started in - set it only if that is not the project),
`--remove`, `--dry-run`.

By hand, the same thing:

```bash
cd mcp-server && npm ci
```

Register for every project on the machine (user scope):

```bash
claude mcp add --scope user alfred -- node C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs C:/projects/Alfred/Alfred/mcp-server/src/index.ts
```

This runs `node` directly - no `npm`/`npx` (which on native Windows would need a `cmd /c` wrapper) and no download
at start. Add `-e ALFRED_URL=http://host:3000` if Alfred is elsewhere, `-e ALFRED_MCP_MASK=1` to start every session
with masked replies.

Per-project alternative - a `.mcp.json` in the odeysys repo root:

```json
{
  "mcpServers": {
    "alfred": {
      "command": "node",
      "args": ["C:/projects/Alfred/Alfred/mcp-server/node_modules/tsx/dist/cli.mjs", "C:/projects/Alfred/Alfred/mcp-server/src/index.ts"]
    }
  }
}
```

Check it: `claude mcp list` shows `alfred` connected; in a session, "list my Alfred cycles".

### Over HTTP (native install, Alfred on another machine)

The native install (specs/012-server-program, docs/server.md) runs this same server with
`ALFRED_MCP_TRANSPORT=http` on `127.0.0.1` (port in `ALFRED_MCP_PORT`), and the backend relays `/mcp` on the UI port
to it - so nothing is installed on your machine. Register the URL you reach the UI on:

```bash
claude mcp add --transport http alfred http://localhost:3000/mcp
```

`localhost:3000` through an SSH tunnel (`ssh -L 3000:localhost:3000 staging`), a LAN address, or the Cloudflare
tunnel URL all work: `/mcp` is reachable wherever the UI is (FR-082), so anyone with the tunnel URL can use these
tools. Each client connection gets its own MCP session; the server never listens beyond loopback, and request bodies
over 10 MB are refused. In the install it is a bundle: `app/mcp/dist/mcp-server.mjs` (src plus the frontend utils
it imports, built by `npm run bundle`) next to `app/mcp/node_modules` (production dependencies only).

The relay is `backend-app/mcpbridge/McpRelayController`: it streams the server-sent events chunk by chunk, passes the
`Mcp-Session-Id` header both ways, and answers `502` with a clear message when the MCP process is down (the Docker
install has no `/mcp`; run `mcp-server` locally there). Differences from the local stdio server:

- **Exports are downloads.** A caller on another machine cannot read the server's disk, so `export_calls` always saves
  into `data/exports` (`ALFRED_EXPORT_DIR`, pinned; only a file name is accepted) and answers with
  `download: /mcp-exports/<name>` instead of a path - open it on the same address as `/mcp`. `McpExportsController`
  serves one file by name, never a path, and deletes exports older than 7 days when the backend starts.
- **`exportFolder` and `sourceRoot` cannot be changed** through `session_settings`: neither may point the server at its
  own folders on a remote caller's behalf.
- Session settings (`maskSecrets`) are per MCP process, so they are shared by every client of that Alfred.

`npm run test:http` runs the whole test suite a second time with every tool call going over this HTTP transport.

## The /alfred-* skills

Thirteen Claude Code skills turn the tools below into a QA loop on the task board (docs/board.md, specs/015). Each is
`skills/alfred-<name>/SKILL.md`; all of them follow one shared `skills/_shared/rules.md`, copied into every skill's
folder as `rules.md` on install so they cannot drift. They ship inside both installers (`app/skills`) and as
`alfred-skills-<version>.zip` on each GitHub release.

| Skill | When | What Claude does | Where it stops for you |
|---|---|---|---|
| `/alfred-guide` | anytime | teaches the flow, "what next?" from your real board, troubleshooting - read-only | - |
| `/alfred-connect <address>` | once per instance | checks an Alfred at any address (`/health`), detects a native install (`/mcp` answers: HTTP) or a Docker one (no `/mcp`: this machine's `mcp-server` with `ALFRED_URL`, `setup_mcp.py --alfred-url … --name …`), names it `alfred-<host>-<port>`, registers it; also `list` / `remove` | before running `claude mcp add` / `remove` |
| `/alfred-setup [project] ["task"]` | start of a task | checks Alfred and capture, creates the cycle, drafts the brief (test steps) and a spec with an Acceptance list | before saving the drafts, before changing capture |
| `/alfred-spec <cycle> …` | anytime | adds or edits the brief / spec files, shows before → after and what marks/cards it affects | before saving |
| `/alfred-listen <cycle>` | while you test | starts the listen runner on your machine (`alfred-listen.mjs` in the skill folder - Alfred may be on another machine): it waits for a pause and runs `check_calls` itself with no model; a clean batch costs no model, a known group is linked in code, a new flagged batch gets one fresh run on a warm Claude process (several in parallel) with the context pack, judging it as review would - cards with evidence and a first state comment, links, step ticks, an outcome for every flagged group, checked by the runner; a failed run stays queued; your comments are answered within seconds by its live lane; at stop a sweep and a whole-cycle pass catch what has no outcome, then three finish runs in parallel (sweep, steps and requirements, regressions and shape) and the session log - see "Listen runner" | when you say stop (`--now` skips the finish, `--finish` resumes one), or pause |
| `/alfred-review <cycle>` | after a recording | checks every call in one pass (`check_calls`), fills the board without duplicates, regressions vs earlier runs (also a field missing or changed format behind a 200, by `diff_calls` against the last good run), annotates, suggests marks | - |
| `/alfred-triage` | after listen / review | one Inbox card at a time with a recommendation; records your decision | every card - you decide |
| `/alfred-sync` | after you answered or changed cards | one state comment per card: what you did and answered, what it means, who it waits on | never moves a card for you |
| `/alfred-fix [card#]` | To do cards | asks which cards when none is named, posts a plan, fixes after **Go**, tests, `board_fix` | before starting, before each card's change |
| `/alfred-verify [cards] [cycle]` | after using the app again (no recording needed) | re-tests Fixed cards from the live calls since each fix (or a cycle) by their expectations, before → after; proposes Verified / comments still failing, guards, regressions, suggested marks | your Accept clicks |
| `/alfred-status` | anytime | what waits on you, on Claude, on a re-test; the next step - read-only | - |
| `/alfred-report` | end of a day or task | a short summary (found, fixed, verified, open, decisions, spec coverage) | writes a file only when asked |
| `/alfred-live` | while you work on the board, beside any other skill | starts the live runner on your machine (`alfred-live.mjs` in the skill folder - Alfred may be on another machine): no model while you are idle, warm Claude processes so an answer starts at once, one fresh short run per change with the card's thread prefetched, cards answered in parallel, failed runs tried again; the card shows each step, the reply typing in and Stop; each answer is a line in this chat (Monitor on the runner's chat log) - see "Live answers" | never moves, closes or marks for you; `--model` only when you name one; one runner per board; stops on `/alfred-live stop` or Pause |
| `/alfred-update-skills` | after updating Alfred | shows which release each installed skill came from, then re-installs them for you and for the current repo's own copy (`alfred skill install`, or `python alfred_skill.py install` in a checkout) | before installing; never `--force` unasked |

The shared rules: Claude never closes, sets scope, marks the checklist or moves to Verified / Done (it proposes); never
starts work you did not choose; **every card carries a state** - a Did / Found / Next comment when it opens the card,
when you acted (what you did and answered), and at each step of its work, with **waiting on** (you / Claude / a
re-test / nobody); one card per problem with evidence in a fixed order; every bug's ERROR / WARN log lines; one
session-log entry per run; `--dry` on any writing skill shows what it would do.

**Flows are learned, not configured** (rules "Flows" … "Project checks"). All 200s are not a pass: listen and review
link calls into flows by the values they carry (a response value that comes back in a later request, our supplier call
or a database write), read each endpoint's code once (the session always runs in the app's repo) and make one
expectation per carried value. A **sure** one (the code copies it through, a spec item or a project check says it) is
compared at every hop and a silent change or a value that disappears is a bug. An **unsure** one (the code recomputes or
re-fetches it, or it is unclear) is never carded on a guess: it goes into one batched question per flow on a `Learn:
<flow>` card. The user's answers (through `/alfred-sync` or `/alfred-triage`), Fine closes on flow values and confirmed
**good runs** (a run where every check held, proposed by Claude, confirmed by the user - the baseline review compares
later runs with) become lines in the app repo's `CLAUDE.md` under `## Alfred checks`, saved only on the user's yes: the
project's memory, versioned with the code and read at the start of every run, so nothing is asked twice.

Install them where Claude Code looks for skills:

```bash
alfred skill install                       # native install: ~/.claude/skills (run as yourself, not admin/root)
alfred skill install --project C:/projects/odeysys   # only that repo: <repo>/.claude/skills (commit it to share)
alfred skill status | remove [--project ...]
python setup_mcp.py                        # source checkout / Docker: registers the MCP server AND installs the skills
                                           #   (--no-skill to skip; --remove removes both)
```

Without a local install (Alfred on another machine), unzip `alfred-skills-<version>.zip` into `~/.claude/skills/`.
An installed copy carries a `.alfred-skill` marker with its version: `install` updates it in place, removes the
retired `/alfred-qa`, and never overwrites a skill of the same name that was not installed by Alfred (`--force`
does).

**After an update** the native supervisor refreshes them on its own start: it runs as the service account (LocalSystem
/ root), so it walks every user's home (Windows: the registry's profile list; Linux: uid 0 and >= 1000) and re-installs
the skills wherever `~/.claude/skills` already holds Alfred-installed ones from an OLDER release (`alfred_skill.
refresh_installed`, one log line per home in `supervisor.log`). A user who never installed them gets none; a copy from a
checkout (`source`) or a newer release is left alone; on Linux the files are given back to the home's owner.
Project-scope copies are never touched (they are in git) - `/alfred-update-skills` does those, and Docker/checkout
installs (`python alfred_skill.py install|status|remove [--project <folder>] [--force]`). A running Claude Code session
keeps the skill text it loaded: start a new one.

`tests/python/test_alfred_skill.py` checks that every tool the skills and the rules name exists in the MCP
server.

## Tools

| Area | Tools |
|---|---|
| Session | `session_settings` - mask secrets in replies on/off; default export folder; `sourceRoot` (the project call chains resolve in) |
| Task (harness) | `task_context` - **start every session here**: a session cycle is a task, and one call gives its whole state from Alfred - the brief by section (Task, Description, Scope, Out of scope, Test steps, Data, Decisions), the requirements (spec Acceptance items with the user's marks, suggestions, cards), the test steps with their results, the open findings (bugs, missing work, notes, questions) with who each waits on, what the user closed and why, Claude's last runs, what Claude is doing now and the one next step. No task: lists the tasks, newest first. The MCP prompt `resume` (Claude Code: `/mcp__alfred__resume <task>`) starts any MCP client - another machine, another agent, no skills installed - on it. Nothing about a task depends on a conversation: the skills write findings, state comments, decisions and a session-log entry back to Alfred |
| Check | `check_calls` - every call of a cycle, or the calls after `sinceCallId` (a listen batch), checked in one pass, nothing skipped: the triage marks' signals (HTTP, logs, SQL, supplier, Redis, errors in 200s, empty results), slow against the same endpoint in the cycle, and **hop diffs** - flows found from the ids calls carry (in a response, a later request, a supplier call, a written row: INSERT/UPDATE parameters by column), every value that changed, went missing or changed count between them (numbers, date-times and case compared by meaning; per-request ids, tokens and timestamps ignored; JSON and XML bodies). Flagged calls come in **groups** - the same problem on many calls (same endpoint, exact status, signals, error and WARN fingerprint, failing supplier outcome, DB flags, failing statement, hop-diff keys) is one group with one example's evidence and every member listed, judged once; anything different is another group - each in the JSON with a stable `key`, its `callIds` (50 at most), `exampleCallId`, `endpoint`, `severity` and `signals`, and paged with `offset`/`next` and `untilCallId` holding the window still (the pages of a batch are the first page's, kept: a mark that changes between two pages moves no group; a page asked for without its first page is worked out again, a sweep over its whole window); every other call listed as clean. A call still running for under five minutes ends a listen batch (`pending`, checked next time; a sweep and a whole-cycle check are never cut by one); one running longer has hung: it is passed over, listed as never completed (`stale`: call number, endpoint, start, age) and a flagged group once per memory so it gets an outcome, and checked when it finishes; a call captured late, or finished late, but timed earlier joins the next batch. `sweep: true` re-judges only calls never checked, whose mark changed since (or that became slow), or that are still settling. How long ago a call ended is judged on Alfred's own clock (the client reads it from the `Date` of Alfred's answers), a call is looked at again for 30 s after it ended. A `sinceCallId` that has left the cycle continues after the time that call had (`resumed`); a process that has not seen the earlier batches takes the calls before `sinceCallId` as checked. `listener` keeps a separate memory per listener (`shared` by default). Built to cost the same per batch at call 9,000 as at 50: the cycle is read incrementally (one page per source, a full re-read when anything before the tail changed), each call's bodies and written rows are parsed once into a per-cycle index of small snapshots (never the bodies; 256 MB across cycles, a dropped index is rebuilt from Alfred), and a call's writes are indexed once its capture is complete or ten seconds after it ended (a call that slots in late is compared with the call after it, and that call is reported again with only what is new: `lateWrites`); bodies Alfred could not give are asked for again, three tries (`indexFailed`). Diffs are 200 lines at most (`maxDiffs`, the reply's size allowing), the changed values and counts before the missing keys, each distinct one of a group once. One call per listen batch: `waitSec` (with `sinceCallId`) waits for the burst to pause (`settleSec` - websocket frames, other cycles' calls, prepared calls and cycle edits do not start it over; a burst is returned 20 s after its first call; a failing call ends it a second after it), for a call checked too early to get its late log lines / SQL, for a call whose writes were still arriving to settle, or for a call that was running to finish, then checks; `boardCursor` adds the user's board changes on the cycle, and a comment of the user's ends the wait. Calls checked before their capture settled are re-judged by the next call (`rechecked`, `recheckPending`). The JSON also names what could not be captured for every project in the batch (`captureGaps`). |
| Triage | `triage` - **start here**: what needs attention first, for a cycle, several cycles / everything (`scope`) or a project's live calls in a time window, in six groups with the evidence attached - failed statements, failing supplier calls, errors in 200 bodies, and the first ERROR log lines of each call (a 2xx that logged an error or an exception is a hidden failure); WARN lines and database flags as weaker evidence (see "Triage" below) |
| Problems (specs/010) | `problem_calls` - every call with an error or a warning from HTTP, the database or the logs, counts per signal first, filters `all` / `any` / `none` over the signals `HTTP_ERROR`, `NO_ANSWER`, `DB_FAILED`, `SUPPLIER_FAILED`, `LOG_ERROR`, `LOG_EXCEPTION`, `REDIS_FAILED`, `DB_WARNING` (any database flag, `dbFlags` to narrow), `LOG_WARNING`, `CACHE_COLD` (a Redis miss on a key an earlier recorded call wrote, TTL run out); `investigate_call` (signals, first error with the five items before it, the exception's source line, failing supplier calls, a similar call that succeeded, the call's Redis at a glance); `endpoint_health`; `problem_timeline` (signals per minute, first seen); `compare_cycles` (log problems new / gone / still, signals side by side) |
| Cycles | `list_cycles`, `get_cycle` (opens with a "Needs attention" line; the debugging story: ✖ errors inside 200 responses, ∅ empty results, ↳ each inbound call's supplier calls, optional `bodyPreview`, OPTIONS preflights hidden and counted), `wait_for_calls` (new calls in a recording cycle, event-driven, ≤ 60 s; `settleSec` returns once the user pauses, with the whole burst), `create_cycle` (empty or from live calls), `rename_cycle`, `start_recording`, `stop_recording`, `add_calls_to_cycle`, `remove_calls_from_cycle` |
| Search / compare | `search_cycle` (inside one cycle, its own copies: text, direction, project, supplier, status, failed incl. errors inside 200s, `needsAttention`, `dbFailed`, slow, time - rows numbered as `get_cycle` numbers them), `diff_calls` (two calls: status/URL/duration, then headers and JSON/XML-aware body hunks; page with `hunkOffset`) |
| Spacers | `add_spacer`, `rename_spacer`, `move_spacer` (how a story is rearranged - calls stay in recorded-time order), `delete_spacer`, `suggest_spacers` (steps proposed from pauses and URL areas; writes nothing) |
| Calls | `search_calls` (project, direction, supplier, text, status/class, failed - including errors inside 200s -, `needsAttention` (>= `minStatus`, default 300), `dbFailed` (a failed statement, whatever the status), slow, time range), `get_call` (everything, or `fields`/`paths` such as `["method","url"]`; carries `attention` - its triage group and failing supplier calls - and `dbFailures`), `get_call_body` (page through a body) |
| Logs | `call_logs` - the application log lines one inbound call wrote (offset, level, thread, logger, message, exception, `matchedBy` CAUGHT), filtered by level or text, paged; `capturedLevel` is the Log level that applied to that call (`levelAssumed` when only the current setting is known); `call_story` (statements, supplier calls and lines in the call's own order - the Together view; `startAt: "firstError"`); `log_context` (the items around one line); `exception_source` (a logged exception's application frames → project file:line); `search_logs` (lines of many calls by text, regex, level, logger, exception type, time - each hit names its call; total exact; a regex stops after 2 s and says `cutShort`); `log_problems` (repeated ERROR/WARN lines grouped by meaning - ids and numbers set aside - with counts, first/last seen, endpoints, new or not; `fingerprint` lists a problem's calls); `outside_logs` (lines no call wrote around a moment, by thread). Masked like bodies; every one says why lines are missing (▤ off, no agent, below the Log level) |
| Database | `db_overview` (summary line, time breakdown, query totals, findings), `db_statements` (filtered, paged; `failedOnly` alone is read from the failed-statement index), `db_statement` (SQL, params, rows, `callers` = call chain, origin HQL), `db_query` (the window's search/SQL over recorded statements), `trace_value` |
| Redis (specs/011) | `redis_commands` - one call's Redis commands in order (seq shared with its statements), filtered `all`/`reads`/`writes`/`misses`/`failed`/`cold` or by key, paged; with `commandId` one command in full: every argument, the reply and the value decoded by Alfred (JSON, Java serialization, Kryo, gzip, Snappy), the value before a write, who last wrote the key; `redis_overview` (counts, hit rate, key patterns, the window's Redis findings); `redis_key_history` (every recorded call that read or wrote a key). Keys masked in the project's settings stay masked; each says when ⬢ was off |
| Comments | `list_comments`, `add_comment` (a note on the whole call by default, or on a line of request/response headers or body; prefixed `🤖 Claude:`), `add_comments` (many at once), `delete_comment` |
| Export | `export_calls` - .md / .json / .html of a cycle, chosen calls or a search; the export dialog's own files (masked, untruncated, .json re-importable), opening with "At a Glance" (steps, failures, errors inside 200s, empty results, notes); `includeDb: "summary"` for a report for people; environment `Local` |
| Code | `locate_source` (call-chain frames → `path/in/project/File.java:line`); `db_statement` (`sources`), `db_statements` (`source`) and `db_overview` (`gapSources`) carry the same |
| Rules and Relive (read-only) | `list_rules`, `get_rule`, `list_relive_cycles`, `list_relive_runs`, `get_relive_run` (each step: state, status, error, what differed from the recording); a call a rule changed shows ⚡ with the rule name |
| Rule proposals | `rule_recipes`, `rule_from_call`, `rule_preview`, `create_rule` (saved OFF under "Proposed by Claude" - narrow, never pausing; the user switches it on, edits or deletes it; the backend refuses everything else to Claude), `rule_hits`. See docs/interception.md "Rules from Claude" |
| Projects | `list_projects` (listen ports, inbound logging, database capture and its agent, log catching and its Log level), `set_inbound_logging` (only with `confirm: true` after the user agreed), `set_db_capture` and `set_log_capture` (▤ on/off, Log level ERROR…TRACE or APP) - Claude may change these two when an investigation needs it (the owner's decision, specs/010); every reply lists `changed` (old → new) for Claude to tell the user |
| Board (specs/014) | Reading: `board_search` (every board, each card with its latest comment; `mine` + To do/In progress is "what was I working on"), `board_changes` (everything after a cursor; `claude` = since Claude's last entry), `board_wait` (waits up to 50 s for the user's next change, woken by the board signal; says when `/alfred-live` is answering the user, and from which machine - the runner's heartbeat is in Alfred), `board_live` / `board_live_stop` (for an agent answering live itself: the user's next changes grouped per card after a short settle, each with what it asks for, the recent thread with indexes for `board_reply` and the open questions; the cursor stays put while the board is paused; a heartbeat in the temp folder lets other sessions on the machine know it runs), `board_live_card` (one card's context for a set of changes - what the live runner prefetches for each run), `board_list` (each card with its linked call ids), `board_get` (a card in full: every comment complete, history paged, a long comment read in parts with `entry`, every mention with the tool that opens it, the open proposal), `board_evidence` (opens every mention of a card in one call), `board_for_call`, `board_similar`, `board_closed_reasons` (paged with `offset` / `nextOffset`, never over the reply budget), `get_brief` (with the cycle's cards and their latest comment), `read_spec` (with marks and Claude's suggestions), `board_verify` (Fixed cards - all or `numbers` - against the live calls since each fix or a re-test cycle, by their expectations with before → after; `record` keeps the history and returns the report, `apply` comments or proposes Verified), `board_retest` (one card's plan, check and history), `board_retest_plan` (expectations and steps). Writing: `board_add` / `board_add_many` (`board_add_many` takes each card's `firstComment` and `specItem` in the same call; always into the Inbox; refused while paused - told apart by the error code, never by the message text - or when the user closed the same problem (a shared call or title, not a signature alone) as Fine / Not in this flow; a 30 s timeout, and a create that timed out is checked on the board before it is called "not added"; a match with an open card is said as "same signature as open #N"), `board_comment` (did / found / next / impact), `board_reply` (with `replyTo`: under one exact comment), `board_ask` (flags Needs decision; the user's answer shows as "ANSWERS your question" in `board_changes` / `board_wait`), `board_fix` (the change with code mentions, root cause, commit, tests, how to verify, and the re-test plan: `expect` + `steps`; moves to Fixed), `board_edit` (Claude's own Inbox cards only), `board_link` / `board_unlink`, `board_move` (To do, In progress, Fixed only), `board_flag`, `board_propose` (Verified / Done / close, for the user to accept), `board_suggest_mark` (a checklist mark the user accepts), `board_status` (the live strip; says when the user paused Claude), `board_teams` (the teams, what each owns and its hints), `board_assign` (set a card's teams - any card, any time, with a reason recorded in its history; `board_add`/`board_add_many` take `teams` too, and `board_list`/`board_search` filter by `team`). Every request is sent as `X-Alfred-Actor: claude`; the backend enforces the limits. See docs/board.md |
| Redactions | `add_default_redactions` - Authorization, Cookie, x-api-key, password (SOAP `wsse:Password` and form fields too), apiKey, tokens; only the missing ones, as normal global Redactions (ask the user first) |

The server offers no MCP prompts: the guided flows are the `/alfred-*` skills (below), so the `/` menu shows them
and not one `debug_*` entry per connected Alfred.

## Live answers

`/alfred-live` answers the user on the board while they work, without a conversation that grows:

- **The runner** (`skills/alfred-live/alfred-live.mjs`, plain Node 18+ with no dependencies, so it ships inside the
  skill) runs **on the user's machine**, beside their Claude Code and the app's repo, wherever Alfred runs - this
  machine, Docker, or a LAN host. `start --server <name>` reads that MCP server's entry from Claude Code's config
  (`~/.claude.json`, user or project scope): Alfred's address is an http server's url without `/mcp`
  (`alfred-lan-83` → `http://192.168.1.83:3000`) or a stdio server's `ALFRED_URL`. It starts itself in the background
  (`run`), with a pid file, a full log and a chat log in the temp folder's `alfred-live/`.
- **One MCP server for every run** (`McpHost`): a stdio entry (the usual local registration, node + tsx + index.ts) is
  started once by the runner in HTTP mode on a free port (`ALFRED_MCP_TRANSPORT=http`, `ALFRED_MCP_PORT=0`, the
  "ready on" line on stderr gives the port) and every run's `--mcp-config` points at it, so a run connects in
  milliseconds instead of starting its own server (about 3 s); an http entry is used as it is. The runner holds its own
  connection too (`McpClient`), for the card context it prefetches.
- **Warm processes** (`ClaudePool`): `claude -p --input-format stream-json` processes are started ahead, so they have
  loaded their config and connected to the MCP server (measured 3-9 s) before a change exists; a prompt is fed as one
  user message and answered in the model's own time (measured 3.3 s to a trivial answer, against 9.3 s cold). One
  process = one run = one fresh context; it ends after its result and another is started ahead. The runs get
  `--tools Read,Grep,Glob,Bash` with `--allowedTools` for the Alfred server, `git diff/log/show/status` and
  `codegraph explore` only, `--no-session-persistence`, `--disable-slash-commands`.
- **Per change:** the runner waits on `/board/changes/wait` with no model running, settles while more entries arrive
  (at most 1.2 s), and per touched card either notes it (a move to To do / In progress, a close, flags, teams - no
  run) or starts a run: the live rules, the card's recent thread as `board_live_card` gives it (indexes, open
  questions, whether a reply answers one of Claude's questions), and what the user did. Cards run in parallel
  (`--parallel`, default 3); a card past the limit is reported "waiting its turn" so it is visible and stoppable; more
  changes on a card being answered are merged into one follow-up run. A run that fails is tried again (a usage limit
  waits 10 min); one that posted nothing on the board is told once to post it; a refused reply ends FAILED with the
  reason. Pause on the live strip keeps the cursor before the changes, so they are answered on resume. The cursor is
  persisted and used again by a runner restarted within 15 minutes.
- **Live on the card:** the run's stream is read as it comes - each tool call becomes a step ("checking call
  in-confi…", "reading OrderMapper.java:58", "→ editing #12 (kind → BUG)") and the reply tool's partial JSON is the
  draft - and reported by a coalescing `Reporter` (`PUT /board/live-work`: the latest state, one request in flight,
  every 250 ms, and once a second while the model thinks, so Stop is read within a second and Alfred's stale clock is
  reset; sizes clamped to what `LiveWorkService` keeps). The card drawer shows the steps, the reply typing in and
  Stop; the column card a spinner with the current step; the live strip a line per run. Stop kills the whole process
  tree (`taskkill /T` on Windows). A run that stops reporting reads as failed after 5 minutes; ended runs fold to
  "✦ 6 s · 4 steps ▸" for 30 minutes.
- **Heartbeat:** the runner `PUT /board/live-runner` (project, host, model, kind) at start and every 20 s whatever it
  is doing; Alfred holds it in memory for 2 minutes and a live-work report refreshes it too (`LiveWorkService`, a
  `live-runner` message on `/ws/board` when one starts or stops). `board_wait`, `board_changes` and `check_calls` ask
  `GET /board/live-runner?project=`, so listen in any session on any machine leaves the user's changes to it.
  `start` refuses when another machine's runner is alive on the board (`--force` overrides); a runner that sees
  another host take the board stands down and says so.
- **In the session - two logs:** every Monitor event costs the watching session a turn, so the runner keeps a full
  log (`<key>.log`: each change, every `· step`, the reply - what `status` shows) and a **chat log** (`<key>.chat.log`)
  the skill watches (`tail -n 0 -F`): only what adds to the session - one line per answer (`#12 "title" · You: … →
  Claude: <reply> → <what was done>`), failures (a warning repeated in a row is written once), start and stop. The
  session writes nothing in reply to an event: it is context for the user's later questions.
- `stop` removes the runner's pid file (the runner ends itself within 2 s - a detached process on Windows cannot be
  signalled gently) and sends a stopped heartbeat, so listen answers the user again.

## Listen runner

`/alfred-listen` is `/alfred-review` done per batch while you test, without a model waiting and without a
conversation that grows - and without losing a batch:

- **The runner** (`skills/alfred-listen/alfred-listen.mjs`, plain Node 18+, importing `/alfred-live`'s runner code
  from `../alfred-live/` - the two are always installed together) runs on your machine like the live runner, finds
  Alfred the same way (`--server` → `~/.claude.json`), shares one MCP server with its runs (`McpHost`) and keeps warm
  `claude` processes (`ClaudePool`, `--parallel`, default 3). Three lanes:
- **The check lane** waits with no model: `check_calls` with `sinceCallId`, `waitSec` 60, `settleSec` 3,
  `boardCursor`, `listener: listen:<cycle>` (its own memory in the server) and `maxDiffs` 200, every page. A batch with
  no flagged group costs no model: counts on the live strip, one line in the full log, its clean calls kept for a
  later run to mark their steps (one small "steps" run every 8 clean batches). A group whose key the ledger knows with
  its card still open is linked in code (`board_link` of up to 3 of its calls, a state comment on the first
  recurrence); a verdict marked `| recurs` is counted. The rest becomes a **judge job**. Late hop diffs
  (`lateWrites`) and hung calls (`stale`) are batches too. Capture gaps (`captureGaps`) are said once. The user's
  changes on cards go to the pack (the live lane answers them); brief / spec / mark edits refresh the pack and never
  start a run.
- **Judge jobs** run in parallel, each ONE fresh run: the system prompt (`--append-system-prompt-file`, cached across
  runs) is `rules.md` + `batch.md`; the user prompt is the **context pack** the runner keeps - `task_context`, the
  brief's Out of scope and Decisions in full (HTTP, not truncated), the Acceptance items with their full 64-hex keys,
  the teams, the closed cards, the test steps and the user's spacers, `git diff --stat` of the task branch (base from
  the brief or the merge base with main), the cards of the cycle as the board holds them now, the titles other runs
  are adding at that moment, what earlier runs learned (code notes per endpoint, verdicts for groups seen before,
  unsure expectations, check lines, the user's answers) - plus, per group, what the board already holds about its
  calls (`/board/call-badges`), `investigate_call` on each group's example call (run in code, in parallel, so the
  run starts with the evidence it would read first), and the batch. A flagged batch arriving while another batch job
  still waits its turn joins that job (its groups renumbered, at most 10 groups a run): a job waits 2 s to gather,
  10 s while another batch is being judged, so a burst of small batches is one run, not one each. A batch with more
  than 10 groups is several jobs of at most 8. The run
  ends with `→`, `•` findings and the blocks the runner merges: `LEDGER` (`G3 = card #14` / `link #9` / `asked #17` /
  `fine: <reason> [| recurs]`, keyed by check_calls' group `key`), `UNSURE`, `CODE`, `CHECK`, `STATE` (≤ 1500 chars).
  The ledger is checked against the batch's groups and the board (a named card must exist): a group left without an
  outcome gets one second look; after that it waits for the stop pass. A failed run stays in the persisted queue
  (`<temp>/alfred-listen/<key>.state.json`): a usage limit waits 10 minutes (said once), "prompt too long" splits the
  job in two, anything else retries after 20 s, 1, 3, 5 minutes. Nothing is dropped.
- **The live lane** is alfred-live's `Runner` with `kind: listen`: the user's comments on cards are answered within
  seconds; it stands down while a real `/alfred-live` runner (kind `live`) holds the board.
- **Paused** on the live strip: jobs stay queued (no card is written) and run on resume.
- **Stop** (`stop` writes a `.stop` file the runner reads within 2 s; it acts after its current wait): the last burst
  settles (`check_calls` with a short wait until `recheckPending` is 0), the queue drains, then the sweep
  (`check_calls` `sweep: true`, every page) and a whole-cycle pass in a fresh memory (`listener: finish:…`) find the
  groups no ledger entry and no card badge cover; three finish runs go in parallel on transient processes
  (`finish-sweep.md`: those groups and the hung calls; `finish-steps.md`: steps, Acceptance marks, requirements
  against the diff, unasked `Learn:` questions, check lines; `finish-regressions.md`: `board_regressions` and
  `compare_cycles` against the most similar earlier cycle, prefetched, then shape regressions with `diff_calls` and
  logging gaps), each retried once and recorded in the state; then in code the calls behind the cycle's cards get a
  "See card #n" comment (`add_comments`) and `board_session_log` is written with the counts, the unasked expectations
  and the check lines to save. `● Listen stopped` only when every phase succeeded; otherwise `⚠ Finish incomplete`
  and `--finish` resumes the phases left, with the state kept. `stop --now` skips the finish; `--finish` runs only it.

## Triage

`triage` answers "what needs attention first" from marks Alfred **saves as calls arrive** (`backend-triage`, its own
`triage.db`), so it costs the same for 10 calls or 10,000: one request for the marks (per 100 calls), one for the failed
statements, and no body is read. A call "needs attention" when its status is at or over `minStatus` (default **300**, so
redirects such as a 307 session check count), it has an error, or it is still running 5 minutes after it started.

| Group | Calls |
|---|---|
| 1 | needs attention, and a supplier call it made needs attention too or hid an error inside a 2xx (e.g. OTA 322) |
| 2 | needs attention, with failed database statements |
| 3 | other calls that need attention |
| 4 | succeeded, but a supplier call or a database statement under it failed - **hidden failures** |
| 5 | succeeded, with an error inside its own body or an empty result |
| 6 | everything else, never left out - commented, database-flagged (fan-out, duplicates, …) or much slower calls first |

Every call is listed once, in its highest group, with its evidence: the failing supplier calls (by their number in the
cycle), the failed statements (`#seq`, table, SQL state, message, swallowed / rolled back, the first call-chain frame
resolved to a project file). A supplier call made by an inbound call of the cycle is evidence under it, not an entry; a
supplier call with no known parent is an entry of its own. The groups are a **reading order, not a filter** - a call
that succeeded can hold the cause (a login that set the session the next call rejected).

How the marks stay current, whatever arrives first (backend-app/triagebridge): every inbound and outbound call is
reported when it is intercepted and when it completes (the body is read once then, for an error inside a 2xx and an
empty result - `backend-triage`'s `SoftFailures`, the Java twin of `soft-failure.ts`; both run
`specs/007-alfred-mcp-server/soft-failure-vectors.json`); a supplier call re-counts its parent's failing supplier
calls; db-capture reports a call's failed / swallowed statement counts after every batch that adds a failed statement
and when the call completes. Writes run on one writer thread, so a webhook is never slowed down. Rows are capped
(`alfred.triage.retention-rows`, default 100,000, oldest first) except calls a session cycle holds. Calls recorded
before this version were marked once at the first start (a marker row in triage.db). A call with no mark (past the cap)
is still listed, under 6, and the header says so; `get_cycle` then judges its body as before.

Endpoints (read-only, behind the gateway): `GET /triage/calls?callIds=…&minStatus=` (≤ 500 ids),
`GET /triage/live?project=&since=&to=&maxPriority=5&minStatus=&limit=` (newest first, ≤ 500),
`GET /triage/counts?project=&since=&to=`; `/ws/triage` signals `attention-changed` with the call ids.

Deliberately **not** offered: deleting or clearing a cycle, editing recorded call content, reordering calls, resend,
editing interception rules, running Relive cycles - anything that changes live traffic or destroys recorded evidence in
bulk. (Switching a project's inbound logging is offered behind `confirm: true`; ◆ database capture, ▤ log catching and the
Log level Claude may change itself, and says so.)

**Scopes** (specs/010): every cross-call tool takes `scope` - `{live:true}` (default), `{cycle}`, `{cycles:[...], includeLive}`
or `{all:true}`. The backend resolves it once (`backend-app/investigationbridge`): a call held live and in cycles counts
once and says where it is held (`heldIn`). The endpoints are POSTs (`/triage/problem-calls`, `/triage/endpoints`,
`/triage/timeline`, `/call-logs/search`, `/call-logs/problems`, `/call-logs/problems/calls`) - scopes and filters travel
in the body, since the gateway refuses a request line over 8 KB (about 200 ids; the tools also send at most 100 ids per
GET). Problem calls, endpoint health and the timeline read triage's saved marks, which carry each call's log
error/warning/exception counts, the Log level it was caught at and its database flags (fed by db-capture through
`triagebridge`, also for imported calls and when a project's thresholds change). Search and grouping read db-capture's
caught lines through an FTS5 trigram index and a per-line fingerprint (`docs/db-capture.md`).

Behaviour worth knowing:

- **Everything Claude changes shows live in an open Alfred UI, without a reload**: cycles, recording state, copied/removed calls and spacers through `/ws/session-cycles`, and comments through `/ws/comments` (a call already open re-reads its comments when one is added or deleted anywhere).
- **Errors inside successful responses** (`shared/utils/soft-failure.ts`): a SOAP `Fault`, an OTA `<Error Code=…>`, JSON `errors`/`error`/`success: false` in a response below 400. The same detector feeds `get_call`, the exports' "At a Glance" and - through the saved triage marks - `triage`, `get_cycle` and the `failed`/`needsAttention` filters (which read a body only for a call with no mark).
- `wait_for_calls` listens on the calls and session-cycles sockets, re-reads the cycle only when one fires, and returns after at most 60 s. Pass the previous reply's `lastCallId` as `sinceCallId` to continue. `until: "logError" | "logWarning" | "dbFailed" | "problem"` waits for the next call with that kind of trouble (listening on `/ws/db-capture` and `/ws/triage` too, since lines and marks settle a moment after a call ends) and lists it under `matched`.

- `create_cycle` leaves the new cycle **paused** unless `record: true` (Alfred itself creates cycles recording - right
  for "new cycle, then reproduce", wrong for a cycle assembled from chosen calls). Several cycles may record at once;
  `start_recording` lists the others.
- Inbound calls are a ring buffer (the last ~1,500). A call that has dropped out is reported as such, with the
  cycles that still hold a copy; read it from there with `cycleId`.
- `search_calls` filters text, project and supplier in Alfred; status, failed, slow and time in the server, scanning
  at most 2,000 recent calls per direction (`scanCapHit` says when the cap was reached).
- Comment line numbers are the call card's: headers as pretty JSON, bodies pretty-printed when JSON/XML.
  `get_call_body` (default `pretty: true`) shows exactly those lines.

## Session settings

The server lives exactly as long as the Claude session, so settings last for the session and are never stored.

- **Masking replies** - "hide secrets for this session" → `maskSecrets: true`: every reply is masked with Alfred's
  Redactions and secret variables - the same rules as exports - including database params, rows and query cells.
  Each reply says `masked` and `maskedValues`; any read tool takes `mask` to override one request.
- **Export location** - with no path, Claude asks where to save each time. "Save exports to C:/tmp/alfred for this
  session" → `exportFolder`; exports with no path or a relative path go there. An existing file is never
  overwritten unless asked.
- **Source root** - where `File.java:line` frames are looked up: the folder Claude Code started the server in, unless
  `ALFRED_SOURCE_ROOT` or `sourceRoot` says otherwise. Source files are indexed by name on first use (build output,
  `node_modules` and dot-folders skipped). A frame carries no package, so when two classes share a name (odeysys has two
  `GenericDAOImpl.java`) the server keeps the file whose method at that line is the frame's method, then the one the
  calling frame's file imports; only a frame that is still ambiguous comes back as `candidates`. A file you edit is re-read.

## Data warning

Alfred keeps bodies, headers, tokens and database rows verbatim (by design). With masking off, tool replies carry
them as recorded, and they reach the model provider through the Claude session. Exported files are always masked
with Alfred's Redactions, as in the UI. Add Redactions (Settings) for anything that must never leave the machine.

## Verify

```bash
cd mcp-server && npm run typecheck && npm test
```

`npm test` runs every tool against an in-memory fake Alfred speaking the real wire shapes (summaries, captured-call
wrappers, part details with their nulls, 404s, and its WebSocket change signals), including parity checks: `db_overview` equals `analyzeCapture` on the same capture, exports equal
the dialog's builders byte for byte apart from the generation time, and the .json re-imports through
`import-parser.ts`.

```bash
cd mcp-server && npm run live-check
```

Against the running Alfred: reads call `500d0cdc-…` (the HQL fan-out #19-#25 and the swallowed failure at #42),
adds a comment, creates a cycle from the call with a spacer, searches it, diffs the call with its cycle copy, reads the
rules, Relive cycles and projects (asking - never flipping - a project switch), exports .md/.json/.html, records a
second cycle while sending marker requests through the first project's reverse-proxy listener (`wait_for_calls` must wake
on them), then deletes everything it made. With `ALFRED_SOURCE_ROOT=<odeysys checkout>` it also resolves a real frame.
`-- --pause` stops before the cleanup so the open UI can be checked. `npx tsx scripts/stdio-check.ts` starts the
server the way Claude Code does and calls a tool over real stdio.

## Troubleshooting

- **"Alfred is not reachable"** - start it (`python3 start.py`) or fix `ALFRED_URL`.
- **"gateway answered 502"** after a backend rebuild - `docker compose restart app-gateway`.
- **Server fails to start: cannot find `@angular/core`** - `cd frontend && npm ci`.
- **Tools missing in Claude** - `claude mcp list`; the registered paths must be absolute.
