#!/usr/bin/env node
// /alfred-live's runner (SKILL.md, docs/mcp.md "Live answers"). Runs on the machine of the Claude session that started
// it - next to the app's repo and that machine's Claude Code - whatever machine Alfred runs on (this one, a LAN host,
// Docker). No dependencies: Node 18+ only, so it ships inside the skill folder. /alfred-listen's runner imports the
// shared parts from here (the MCP client and host, the warm Claude pool, the reporter), so the two skills are always
// installed together.
//
//   node alfred-live.mjs start  --server <mcp name> [--project p] [--cycle id] [--model m] [--parallel n] [--cwd repo]
//                               [--no-board-runs] (answer comments only; ▶ on the board copies the prompt)
//                               [--chat id] [--chat-pid n] (the chat that started it; read from CLAUDE_CODE_SESSION_ID / CLAUDE_PID)
//   node alfred-live.mjs status --server <mcp name> [--project p]
//   node alfred-live.mjs stop   --server <mcp name> [--project p]
//
// --server is the Alfred MCP server as Claude Code has it registered ("alfred-lan-83"): its entry in ~/.claude.json
// gives Alfred's address (an http server's url without /mcp, or a stdio server's ALFRED_URL). A stdio entry is started
// ONCE by the runner in HTTP mode (McpHost) and every run connects to it, so a run never pays the server's start-up;
// an http entry is used as it is. `start` starts the runner in the background and prints where its logs are.
//
// The runner waits on Alfred's board for the user's next change with no model running - but it keeps a warm `claude`
// process ready (ClaudePool), so a change is answered the moment it arrives. Each card the user touched is either noted
// (a move to To do / In progress, a close, flags, teams) or answered by ONE fresh run that sees only that change and the
// card's recent thread - so no conversation grows. Cards are answered in parallel (--parallel, default 3). The run's
// stream is read as it comes: each tool call becomes a step and the reply tool's partial input is the draft, reported to
// Alfred (PUT /board/live-work) so the card shows Claude working - steps, the reply typing in, Stop - while it happens.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_RULES, ChatLane, chatTools, sessionIdOf } from './chat.mjs';

// ------------------------------------------------------------------------------------------------- what the user did

const pretty = (v) => String(v ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** "You moved it In progress → Fixed" - for the log, the quiet note and the run's prompt. */
/**
 * The cursor with its chat part reset: only WAITING chat messages come back, so reading them from the start never
 * repeats an answered one - it finds those sent before this runner started or while it stood down.
 */
export function chatsFromStart(cursor) {
  const parts = String(cursor ?? 'now').split('.');
  return parts.length === 3 ? `${parts[0]}.${parts[1]}.0` : cursor;
}

export function youDid(e) {
  // a rich text comment is HTML: its words only, for a one-line note
  const text = String(e.text ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  switch (e.kind) {
    case 'COMMENT': return e.replyTo != null ? `You replied: ${short}` : `You: ${short}`;
    case 'STATUS': return `You moved it ${pretty(e.oldValue)} → ${pretty(e.newValue)}`;
    case 'RESOLUTION': return `You closed it as ${pretty(e.newValue)}${short ? ` - ${short}` : ''}`;
    case 'REASON': return `You gave the reason: ${short}`;
    case 'DESCRIPTION': return 'You edited the description';
    case 'REACTION': return e.text === '✅' ? 'You gave the go-ahead ✅' : `You reacted ${e.text ?? ''}`;
    case 'COMMENT_EDITED': return `You edited your comment: ${short}`;
    case 'TITLE': return `You renamed it: ${e.newValue ?? ''}`;
    case 'KIND': return `You changed its kind ${e.oldValue ?? ''} → ${e.newValue ?? ''}`;
    case 'FLAGS': return `You changed its flags: ${e.newValue ?? ''}`;
    case 'TEAMS': return `You changed its teams: ${e.newValue ?? ''}`;
    case 'PROPOSAL_ACCEPTED': return 'You accepted the proposal';
    case 'PROPOSAL_DISMISSED': return 'You dismissed the proposal';
    case 'REOPENED': return 'You reopened it';
    default: return `You: ${String(e.kind).toLowerCase()}`;
  }
}

/** The live box's heading for what the user did; quiet = noted only, no run. */
export function headOf(changes, answersQuestion) {
  if (changes.some((e) => e.kind === 'COMMENT' && e.replyTo != null && answersQuestion(e))) return { head: 'acting on your answer', quiet: false };
  if (changes.some((e) => e.kind === 'COMMENT' && e.replyTo != null)) return { head: 'working on your reply', quiet: false };
  const comment = changes.find((e) => e.kind === 'COMMENT');
  if (comment) return { head: /\?\s*$|@claude/i.test(comment.text ?? '') ? 'working on your question' : 'working on your comment', quiet: false };
  if (changes.some((e) => e.kind === 'REACTION' && e.text === '✅')) return { head: 'going ahead', quiet: false };
  if (changes.some((e) => e.kind === 'COMMENT_EDITED')) return { head: 'reading your edit', quiet: false };
  if (changes.some((e) => e.kind === 'STATUS' && e.newValue === 'FIXED')) return { head: 'preparing the re-test', quiet: false };
  if (changes.some((e) => e.kind === 'PROPOSAL_DISMISSED' || e.kind === 'REOPENED')) return { head: 'reading why', quiet: false };
  if (changes.some((e) => e.kind === 'DESCRIPTION' || e.kind === 'TITLE' || e.kind === 'KIND')) return { head: 'reading your edit', quiet: false };
  return { head: 'noting your change', quiet: true };
}

// --------------------------------------------------------------------------------------------- what the run is doing

/** One tool call of the run as the step the user reads. */
export function stepLabel(tool, input = {}) {
  const name = String(tool).replace(/^mcp__.+?__/, '');
  const s = (k) => (typeof input[k] === 'string' || typeof input[k] === 'number' ? String(input[k]) : '');
  const card = s('number') ? `#${s('number')}` : 'the card';
  const id = (v) => (v.length > 12 ? `${v.slice(0, 8)}…` : v);
  switch (name) {
    case 'task_context': return 'reading the task';
    case 'board_get': return `reading ${card}`;
    case 'board_evidence': return `opening ${card}'s evidence`;
    case 'board_search': case 'board_list': case 'board_similar': case 'board_for_call': return 'looking for related cards';
    case 'investigate_call': case 'get_call': case 'call_story': return `checking call ${id(s('callId'))}`;
    case 'get_call_body': return `reading the body of call ${id(s('callId'))}`;
    case 'diff_calls': return 'comparing two calls';
    case 'call_logs': case 'log_context': return 'reading the log lines';
    case 'search_logs': return `searching the logs for "${s('query') || s('text')}"`;
    case 'db_statements': case 'db_statement': case 'db_overview': return 'reading the SQL';
    case 'redis_commands': return 'reading the Redis commands';
    case 'endpoint_health': return `checking ${s('endpoint') || 'the endpoint'}'s history`;
    case 'problem_calls': case 'triage': case 'check_calls': return 'checking the calls';
    case 'compare_cycles': return 'comparing with an earlier run';
    case 'board_regressions': return 'checking for regressions';
    case 'trace_value': return `tracing "${s('value')}" through the calls`;
    case 'read_spec': case 'get_brief': return 'reading the spec';
    case 'exception_source': case 'locate_source': return 'finding the code line';
    case 'board_reply': case 'board_ask': case 'board_comment': return 'writing the reply';
    case 'board_edit': return `→ editing ${card}${s('kind') ? ` (kind → ${s('kind')})` : ''}`;
    case 'board_add': return `→ adding a card: ${s('title')}`;
    case 'board_add_many': return `→ adding ${Array.isArray(input.cards) ? `${input.cards.length} card${input.cards.length === 1 ? '' : 's'}` : 'cards'}`;
    case 'board_link': return `→ linking evidence to ${card}`;
    case 'board_link_spec': return `→ linking ${card} to its requirement`;
    case 'board_propose': return `→ proposing ${pretty(s('status') || 'a step')}`;
    case 'board_flag': return `→ flagging ${card}`;
    case 'board_assign': return `→ assigning ${card} to ${Array.isArray(input.teams) ? input.teams.join(', ') : 'teams'}`;
    case 'board_retest_plan': return `→ setting ${card}'s re-test plan`;
    case 'board_move': return `→ moving ${card} to ${pretty(s('status'))}`;
    case 'board_mark_step': return `→ marking a step ${pretty(s('state'))}`;
    case 'board_suggest_mark': return '→ suggesting a checklist mark';
    case 'board_session_log': return '→ writing the session log';
    case 'add_comment': case 'add_comments': return '→ annotating the calls';
    case 'ToolSearch': return 'loading tools';
    case 'Read': return `reading ${basename(s('file_path'))}${s('offset') ? `:${s('offset')}` : ''}`;
    case 'Grep': return `searching the code for "${s('pattern')}"`;
    case 'Glob': return `finding files ${s('pattern')}`;
    case 'Bash': return /^codegraph/.test(s('command')) ? 'exploring the code graph' : `running ${s('command').split(/\s+/).slice(0, 2).join(' ')}`;
    default: return name.replace(/_/g, ' ');
  }
}

/**
 * The Alfred tools a live answer may need. With every tool of the server on the run (107), Claude Code defers them
 * behind ToolSearch: each run spends a model turn finding its tools (1-3 s, a 57k-token prompt). With only these loaded
 * (ENABLE_TOOL_SEARCH=false, the rest disallowed) the first tool call is the Alfred tool itself and a turn costs ~33k.
 */
export const LIVE_TOOLS = ['board_get', 'board_reply', 'board_ask', 'board_comment', 'board_edit', 'board_add', 'board_flag', 'board_assign', 'board_propose',
  'board_retest_plan', 'board_link', 'board_evidence', 'board_search', 'board_similar', 'board_for_call', 'board_suggest_mark', 'board_teams', 'board_mark_step',
  'get_call', 'investigate_call', 'call_story', 'get_call_body', 'call_logs', 'log_context', 'db_statements', 'db_statement', 'search_calls', 'read_spec',
  'task_context', 'trace_value', 'exception_source', 'locate_source', 'diff_calls', 'endpoint_health'];

/** The tools a listen judge run may need: the live ones plus the drill-down, the board writes and what the finish does. */
export const LISTEN_TOOLS = [...LIVE_TOOLS, 'board_add_many', 'board_link_spec', 'board_session_log', 'board_steps', 'board_regressions', 'board_list',
  'board_closed_reasons', 'get_brief', 'add_comment', 'add_comments', 'search_logs', 'log_problems', 'db_overview', 'redis_commands', 'compare_cycles',
  'problem_calls', 'triage', 'suggest_spacers', 'get_cycle', 'list_cycles', 'search_cycle', 'outside_logs', 'problem_timeline', 'redis_overview',
  'board_requirements', 'board_evidence_put'];

/** The tools whose call writes something on the board (a run that made none of these answered nothing). */
export const WRITE_TOOLS = /board_(reply|ask|comment|edit|add|add_many|flag|assign|propose|retest_plan|link|link_spec|move|mark_step|suggest_mark|session_log|fix|evidence_put)$|^(mcp__.+__)?add_comments?$|(^|__)chat_(reply|summary)$/;

/** The reply text from a reply tool's partial JSON input - shown as it types in. */
export function draftOf(partialJson) {
  const m = /"(?:text|question|did)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (!m) return null;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16))
    : c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

export const RULES = `You are Alfred live: you answer the user on the Alfred task board while they work, one change of theirs at a time.
- The card's recent thread is below, with [indexes]: read it; board_get only for entries older than the ones shown, and nothing else you do not need.
- Answer in the card's thread with board_reply (replyTo = the [index] of the user's comment, or of your question they answered). 1-3 short sentences, plain words, in the user's language. Say what you did, never what you are about to think.
- An answer to your question: reply with what it changes ("Got it - ..."), then do it within the board's limits (board_edit your own Inbox card's kind/description, board_add a BUG with the calls, board_flag, board_assign). A question back only when it is still unclear (board_ask, once).
- A question to you: look it up first (at most three Alfred or code lookups, independent ones in the same turn - each turn costs seconds), then answer with the evidence as mentions (@[call:in:<id>|label]).
- A move to Fixed with no re-test plan: board_retest_plan. A dismissed proposal: one board_comment (did/found/next) with what you will do instead. An edit: answer only if it changes your work.
- Never move cards to To do for the user, never close, mark the checklist or set scope - propose (board_propose, board_suggest_mark).
- The app's repo is your working folder: read the code there when the answer needs it. Change no file.
- End with one line: "→ " and what you did (e.g. "→ replied; turned #12 into a BUG").`;

/** The prompt of one run: the rules, which tools, the card, its recent thread as the board gives it, and what the user did. */
export function promptFor(server, card, changes, context = null, repo = null) {
  const thread = context ? `\nTHE CARD (from the board):\n${typeof context === 'string' ? context : JSON.stringify(context, null, 1)}\n` : '';
  return `${RULES}\n\nThe Alfred tools are mcp__${server}__* (e.g. mcp__${server}__board_reply).\n\n`
    + `CARD: project "${card.project}" #${card.number} "${card.title}" (${card.status})\n${thread}`
    + (repo ? `\nTHE CODE: ${repo}\n` : '')
    + `WHAT THE USER JUST DID:\n${changes.map((e) => `- ${youDid(e)}${e.replyTo != null && !context ? ' (a reply in a thread - board_get shows which comment)' : ''}`).join('\n')}\n\n`
    + 'Answer this change now.';
}

/** Who a live-runner heartbeat is, for people: "/alfred-live", "/alfred-listen's live lane (cycle decc8783)". */
export function answererName(r) {
  return (r?.kind ?? 'live') === 'listen' ? `/alfred-listen's live lane${r?.cycleId ? ` (cycle ${String(r.cycleId).slice(0, 8)})` : ''}` : '/alfred-live';
}

/** A card's code links as repo-relative paths: "odeysysadmin-tt/src/main/java/X.java" (the ":line" dropped). */
export function codePaths(links) {
  return [...new Set((links ?? []).filter((l) => String(l.type).toLowerCase() === 'code')
    .map((l) => String(l.ref ?? '').replace(/:\d+(-\d+)?$/, '').replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean))];
}

/**
 * Where a card's code is on this machine (specs/020): the folder holding the files its code links name - this runner's
 * folder, a folder beside it, or one level inside those. The live lane once answered "the backend is not in this folder"
 * from the frontend repo while the card linked nine backend lines; now the prompt says where they are, or that they
 * are not on this machine. Returns { dir, here } - here: the runner's own folder - or { missing: true, looked }.
 */
export function findRepo(paths, cwd) {
  if (!paths.length) return null;
  const has = (dir) => paths.some((p) => existsSync(join(dir, p)));
  if (has(cwd)) return { dir: cwd, here: true };
  const seen = new Set([resolve(cwd)]);
  const candidates = [];
  const listDirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(dir, d.name)); } catch { return []; } };
  for (const sibling of listDirs(dirname(resolve(cwd)))) {
    candidates.push(sibling, ...listDirs(sibling));
  }
  for (const dir of candidates) {
    const r = resolve(dir);
    if (seen.has(r)) continue;
    seen.add(r);
    if (has(r)) return { dir: r, here: false };
  }
  return { missing: true, looked: dirname(resolve(cwd)) };
}

/** The THE CODE line of a prompt, or null when the card links no code. */
export function repoHint(paths, found) {
  if (!found) return null;
  const first = paths[0];
  if (found.here) return null;
  if (found.missing) {
    return `the card's code (${first.split('/')[0]}/…) is NOT on this machine - looked in ${found.looked} and the folders in it. Say so and give `
      + 'the file:line from the card\'s code links; never say the code does not exist or is not part of the change.';
  }
  return `the card's code is in ${found.dir} (not this runner's folder) - read it there with absolute paths, e.g. ${join(found.dir, first)}.`;
}

/**
 * The line a ▶ from the board puts in the chat that handles the cycle (docs/board.md "Run from the board"): the chat
 * watches this runner's chat log, so the run happens there - with the chat's own context, model and account. One line
 * (the watch reads lines): the full prompt comes back from board_run_take.
 */
export function boardRunLine(run) {
  const flat = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  return `▶ from the board: ${flat(run.command, 200)}${run.note ? ` · note: ${flat(run.note, 500)}` : ''} · run ${run.id}`
    + ` - board_run_take ${run.id}, run it in this chat, then board_run_end`;
}

/** A comment that needs the code or an investigation goes to the chat; a small one the runner answers itself (~10 s). */
const INVESTIGATE = /\b(why|fix|fixe[sd]|check|investigate|explain|debug|root cause|look into|find out|trace|reproduce|dig|figure out)\b/i;

export function forTheChat(changes) {
  return changes.some((e) => e.kind === 'COMMENT' && INVESTIGATE.test(String(e.text ?? '')));
}

/** The line that hands a comment to the chat: it answers on the card with what the chat knows. */
export function commentLine(card, changes) {
  const said = changes.filter((e) => e.kind === 'COMMENT').map((e) => String(e.text ?? '').replace(/\s+/g, ' ').trim()).join(' / ');
  return `💬 #${card.number} "${String(card.title ?? '').slice(0, 120)}" · you commented: "${said.length > 600 ? `${said.slice(0, 600)}…` : said}"`
    + ` - investigate in this chat and answer on the card (board_get ${card.number}, then board_reply)`;
}

/**
 * What the user did on a card of the cycle, handed to the terminal session that answers the cycle (plan-terminal-answers.md):
 * it answers on the card itself, in the session that knows the code and the chat.
 */
export function cardLine(card, changes, head) {
  const did = changes.map(youDid).join(' · ');
  return `✉ #${card.number} "${String(card.title ?? '').slice(0, 120)}" · ${did.length > 700 ? `${did.slice(0, 700)}…` : did}`
    + ` - ${head ?? 'answer it'} on the card in this session (board_get ${card.number}, then board_reply)`;
}

// ------------------------------------------------------------------------------------------------------- Alfred I/O

/** The MCP server's entry in Claude Code's config (~/.claude.json): user scope, then the folder's project scope. */
export function serverEntry(name, cwd, configPath) {
  configPath ??= join(homedir(), '.claude.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`cannot read ${configPath} - is Claude Code set up on this machine?`);
  }
  const projects = config.projects ?? {};
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
  const here = Object.entries(projects).find(([p]) => norm(p) === norm(cwd))?.[1];
  const entry = here?.mcpServers?.[name] ?? config.mcpServers?.[name];
  if (!entry) throw new Error(`no MCP server "${name}" in Claude Code's config - see /alfred-connect list`);
  return entry;
}

/** Alfred's address from that entry. */
export function alfredUrlOf(entry) {
  if (entry.url) return String(entry.url).replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  return String(entry.env?.ALFRED_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * The user and session this runner answers for (specs/031 board lock): the helper that starts a board's session sets
 * ALFRED_KEY (the user's key) and ALFRED_VIA (the session id), so the runner's writes on a board the user holds go
 * through. Unset: no headers, as before.
 */
export function identityHeaders(env = process.env) {
  return { ...(env.ALFRED_KEY ? { 'X-Alfred-Key': env.ALFRED_KEY } : {}), ...(env.ALFRED_VIA ? { 'X-Alfred-Via': env.ALFRED_VIA } : {}) };
}

export class Alfred {
  constructor(url) {
    this.url = url;
    this.stopper = new AbortController();
  }

  /** Ends every call in flight at once (a stop: the long poll for changes, a wait for calls); calls made after it work. */
  abort() {
    const s = this.stopper;
    this.stopper = new AbortController();
    s.abort(new Error('stopped'));
  }

  async call(method, path, { query, body, timeoutMs = 20_000 } = {}) {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.stopper.signal]),
      headers: { Accept: 'application/json', 'X-Alfred-Actor': 'claude', ...identityHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).message ?? text; } catch { /* plain text */ }
      const error = new Error(`Alfred ${method} ${path} → ${res.status}: ${String(message).slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
}

/** The user's changes per card, oldest first; nothing of Claude's. */
export function byCard(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.actor !== 'USER') continue;
    const key = `${e.project}\u0000${e.number}`;
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return [...out.values()];
}

// -------------------------------------------------------------------------------------------------------- MCP client

/**
 * A minimal MCP client for one server entry of Claude Code's config: stdio (spawns command + args with env) or
 * Streamable HTTP (url). call(name, args) returns the tool's text and throws on a tool error.
 */
export class McpClient {
  constructor(entry, { cwd, name = 'alfred-runner' } = {}) {
    this.entry = entry;
    this.cwd = cwd;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.stopper = new AbortController();
    this.proc = null;
    this.session = null;
    this.ready = null;
    this.restarts = 0;
    this.tools = null;
  }

  get http() {
    return !!this.entry.url;
  }

  async call(name, args, timeoutMs = 120_000) {
    if (!this.ready) this.ready = this.connect();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null; // a failed connect is tried again on the next call
      throw error;
    }
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) {
      let message = text;
      try { message = JSON.parse(text).message ?? text; } catch { /* plain text */ }
      throw new Error(`${name}: ${message}`);
    }
    return text;
  }

  /** The server's tool names (cached). */
  async listTools() {
    if (this.tools) return this.tools;
    if (!this.ready) this.ready = this.connect();
    await this.ready;
    const result = await this.request('tools/list', {}, 30_000);
    this.tools = (result?.tools ?? []).map((t) => t.name);
    return this.tools;
  }

  async connect() {
    if (!this.http) this.spawnServer();
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: this.name, version: '1' } }, 60_000);
    await this.notify('notifications/initialized');
  }

  spawnServer() {
    const { command, args = [], env = {} } = this.entry;
    if (!command) throw new Error('the MCP server entry has neither url nor command');
    const shell = process.platform === 'win32' && !/\.exe$/i.test(command) && command !== 'node' && command !== process.execPath;
    const quote = (a) => (shell && /\s/.test(a) ? `"${a}"` : a);
    // A stdio server: never let this process's ALFRED_MCP_TRANSPORT (a native install's http) turn it into an HTTP one.
    const inherited = { ...process.env };
    delete inherited.ALFRED_MCP_TRANSPORT;
    const proc = spawn(shell ? quote(command) : command, args.map(quote), {
      cwd: this.cwd, env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell,
    });
    this.proc = proc;
    let buffer = '';
    this.stderr = '';
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.onMessage(line);
    });
    proc.on('error', (error) => { this.stderr = `${this.stderr}\n${error.message}`; });
    proc.on('close', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null; // the next call starts it again (its check_calls memory is gone: the runner says so)
      this.restarts++;
      for (const [, p] of this.pending) p.reject(new Error(`the MCP server ended${this.stderr ? `: ${this.stderr.trim().split('\n').at(-1)}` : ''}`));
      this.pending.clear();
    });
    proc.stdin.on('error', () => { /* it ended; close handles it */ });
  }

  onMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null || !this.pending.has(msg.id)) return;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    if (this.http) return this.post(msg, timeoutMs, true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${params?.name ?? method}: no answer within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  async notify(method) {
    const msg = { jsonrpc: '2.0', method };
    if (this.http) await this.post(msg, 30_000, false);
    else this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Ends every request in flight at once (a stop: a check_calls still waiting for calls); requests made after it work. */
  abort() {
    const s = this.stopper;
    this.stopper = new AbortController();
    s.abort(new Error('stopped'));
    for (const [, p] of this.pending) p.reject(new Error('stopped'));
    this.pending.clear();
  }

  async post(msg, timeoutMs, wantReply, retried = false) {
    const res = await fetch(this.entry.url, {
      method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.stopper.signal]),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.entry.headers ?? {}),
        ...identityHeaders(), ...(this.session ? { 'mcp-session-id': this.session } : {}) },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if ((res.status === 404 || res.status === 400) && this.session && msg.method !== 'initialize' && !retried) {
      // the server forgot the session (restarted): a new one - check_calls' memory is per server process, not per session
      this.session = null;
      this.restarts++;
      await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: this.name, version: '1' } }, 60_000);
      await this.notify('notifications/initialized');
      return this.post(msg, timeoutMs, wantReply, true);
    }
    if (!res.ok) throw new Error(`MCP ${msg.method} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (!wantReply) return null;
    const body = await res.text();
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
      : [JSON.parse(body)];
    const reply = messages.find((m) => m && m.id === msg.id);
    if (!reply) throw new Error(`MCP ${msg.method}: no reply in the response`);
    if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
    return reply.result;
  }

  close() {
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }
}

/**
 * One MCP server for the runner and all its runs. A stdio entry (the usual local registration: node + tsx + index.ts)
 * is started once here in HTTP mode on a free port (ALFRED_MCP_TRANSPORT=http, ALFRED_MCP_PORT=0), so a run connects in
 * milliseconds instead of starting its own server (about 3 s each) and check_calls' memory lives in one place. An http
 * entry (a LAN Alfred's /mcp) is used as it is. A server whose command does not answer in HTTP mode within 15 s is
 * closed and the entry is used as it is (each run then starts its own server, as before).
 */
export class McpHost {
  constructor(entry, { cwd, log = () => {} } = {}) {
    this.given = entry;
    this.cwd = cwd;
    this.log = log;
    this.entry = entry;
    this.proc = null;
    this.closed = false;
  }

  async start() {
    if (this.given.url || !this.given.command) return this.entry;
    const url = await this.spawn().catch((error) => { this.log(`  ⚠ shared MCP server not started (${error.message}) - each run starts its own`); return null; });
    this.entry = url ? { type: 'http', url } : this.given;
    return this.entry;
  }

  spawn() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {} } = this.given;
      const shell = process.platform === 'win32' && !/\.exe$/i.test(command) && command !== 'node' && command !== process.execPath;
      const quote = (a) => (shell && /\s/.test(a) ? `"${a}"` : a);
      const proc = spawn(shell ? quote(command) : command, args.map(quote), {
        cwd: this.cwd, env: { ...process.env, ...env, ALFRED_MCP_TRANSPORT: 'http', ALFRED_MCP_PORT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell,
      });
      this.proc = proc;
      let out = '';
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('no "ready on" line within 15 s')); } }, 15_000);
      proc.stderr.on('data', (d) => {
        out = (out + d.toString()).slice(-4000);
        const m = /ready on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(out);
        if (m && !done) { done = true; clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('error', (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
      proc.on('close', (code) => {
        if (!done) { done = true; clearTimeout(timer); reject(new Error(`exited with ${code}: ${out.trim().split('\n').at(-1) ?? ''}`)); return; }
        if (this.proc !== proc || this.closed) return;
        // It died under us: start it again so the runs keep their server (check_calls' memory is gone - the listen
        // runner notices through its client's restarts count and sweeps at stop).
        this.log('  ⚠ the shared MCP server ended - starting it again');
        this.spawn().then((url) => { this.entry = { type: 'http', url }; this.onRestart?.(url); }).catch((e) => this.log(`  ⚠ ${e.message}`));
      });
    });
  }

  close() {
    this.closed = true;
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }
}

// --------------------------------------------------------------------------------------------------- Claude processes

/** The `claude` command as an executable path (so no shell is needed and a kill reaches the process itself). */
export function findClaude(command = 'claude') {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return command;
}

/** Ends a process and everything it started (claude starts its MCP servers): the whole tree, on every platform. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* below */ }
  }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
}

/** How a run failed, from its result or stderr, in one line. */
export function failureOf(result, stderr) {
  return (result?.text?.trim() || String(stderr ?? '').trim().split('\n').at(-1) || 'the run ended without a result').slice(0, 300);
}

/** The run's one-line summary: its last line starting "→". */
export function summaryOf(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('→')).at(-1) ?? null;
}

/** What kind of failure a run's text describes - decides how long to wait before trying again. */
export function failureKind(text) {
  const t = String(text ?? '').toLowerCase();
  if (/usage limit|rate limit|too many requests|429|quota|limit reached|out of credits|billing/.test(t)) return 'limit';
  if (/prompt is too long|context window|too long/.test(t)) return 'too-long';
  if (/not logged in|authentication|unauthorized|invalid api key|login/.test(t)) return 'auth';
  return 'transient';
}

/**
 * Warm `claude` processes: each is started ahead with `--input-format stream-json`, so it has loaded its config and
 * connected to the Alfred MCP server (3-9 s) before a prompt exists; when a prompt arrives it is fed as one user
 * message and the process answers in the time the model needs (measured: 3.3 s to a trivial answer, against 9.3 s
 * cold). One process = one run = one fresh context; it ends after its result and another is started ahead. An idle
 * warm process costs nothing but memory; one left idle for 20 minutes is replaced.
 */
export class ClaudePool {
  /**
   * @param o {{ size?: number, claude?: string, claudeArgs?: string[], cwd: string, server: string, mcpConfigFile: string,
   *   model?: string, systemPromptFile?: string, tools?: string[], allowed?: string[], disallowed?: string[], env?: object,
   *   log?: Function, warm?: boolean, only?: string[], serverTools?: string[] }}
   * only + serverTools: the server's tools NOT in `only` are disallowed and tool search is off, so a run starts with its
   * tools loaded instead of a ToolSearch turn.
   */
  constructor(o) {
    this.o = o;
    this.size = Math.max(0, o.size ?? 1);
    // Warm processes kept ready: one per pool by default (each is a claude process of a few hundred MB); the second and
    // later runs of a burst start cold (about 6 s more) rather than keeping three processes idle for hours.
    this.warmSize = Math.min(this.size, o.warmSize ?? 1);
    this.warm = [];
    this.active = new Set();
    this.closed = false;
    this.claude = o.claudeArgs ? o.claude : findClaude(o.claude ?? 'claude');
    if (o.warm !== false) this.fill();
  }

  /** extra: per-run arguments (a chat's --resume / --fork-session); o.persist keeps the session on disk (a chat continues it). */
  args(extra = []) {
    const o = this.o;
    const allowed = [`mcp__${o.server}`, 'Read', 'Grep', 'Glob', ...(o.allowed ?? [])];
    const lean = o.only && o.serverTools?.length ? o.serverTools.filter((t) => !o.only.includes(t.replace(/^mcp__.+?__/, ''))).map((t) => (t.startsWith('mcp__') ? t : `mcp__${o.server}__${t}`)) : [];
    const disallowed = [...(o.disallowed ?? []), ...lean];
    return [...(o.claudeArgs ?? []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', o.mcpConfigFile, '--strict-mcp-config', ...(o.persist ? [] : ['--no-session-persistence']), '--disable-slash-commands',
      ...extra,
      ...(o.tools ? ['--tools', o.tools.join(',')] : []),
      '--allowedTools', ...allowed,
      ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
      ...(o.systemPromptFile ? ['--append-system-prompt-file', o.systemPromptFile] : []),
      ...(o.model ? ['--model', o.model] : [])];
  }

  spawnOne(extra = []) {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.claude);
    const quote = (a) => (useShell && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const args = this.args(extra);
    const child = spawn(useShell ? quote(this.claude) : this.claude, useShell ? args.map(quote) : args, {
      cwd: this.o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: useShell,
      env: { ...process.env, ...(this.o.only && this.o.serverTools?.length ? { ENABLE_TOOL_SEARCH: 'false' } : {}), ...(this.o.env ?? {}) },
    });
    const p = { child, startedAt: Date.now(), stderr: '', lines: [], waiters: [], ended: false, error: null, initAt: null };
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) p.push ? p.push(line) : p.lines.push(line);
    });
    child.stderr.on('data', (d) => { p.stderr = (p.stderr + d.toString()).slice(-3000); });
    child.on('error', (error) => { p.error = error; p.ended = true; for (const w of p.waiters.splice(0)) w(); });
    child.on('close', () => { if (buffer.trim()) (p.push ?? ((l) => p.lines.push(l)))(buffer); p.ended = true; for (const w of p.waiters.splice(0)) w(); });
    child.stdin.on('error', () => { /* a process that ended before reading */ });
    return p;
  }

  fill() {
    while (!this.closed && this.warm.length < this.warmSize) this.warm.push(this.spawnOne());
  }

  /** A process ready to take a prompt: a warm one when there is one, else a new one. */
  acquire(extra = []) {
    if (extra.length) {
      // a run that resumes a session cannot use a warm process (its arguments are fixed when it starts)
      const own = this.spawnOne(extra);
      this.active.add(own);
      return own;
    }
    const fresh = this.warm.filter((p) => !p.ended && Date.now() - p.startedAt < 20 * 60_000);
    for (const stale of this.warm.filter((p) => !fresh.includes(p))) { killTree(stale.child); }
    this.warm = fresh;
    const p = this.warm.shift() ?? this.spawnOne();
    this.active.add(p);
    this.fill();
    return p;
  }

  /**
   * Feeds the prompt to a process and reads its stream: each tool call is a step (onStep(step, steps, draft, tool, input)
   * - a truthy return ends the run: the user's Stop), reply tools' partial input is the draft (onStep(null, ...)), each
   * tool result goes to onToolResult(toolUseId, isError, text). Resolves with { steps, result, stderr, stopAsked,
   * writes } where writes counts the board-writing tool calls that succeeded.
   */
  run(p, prompt, { onStep = async () => false, onToolResult = () => {}, timeoutMs = 10 * 60_000, inactivityMs = 4 * 60_000, draftEveryMs = 400 } = {}) {
    const steps = [];
    const handle = { draft: null, p, kill: () => { stopAsked = true; killTree(p.child); } };
    let result = null;
    let partial = '';
    let partialTool = null;
    let lastDraftAt = 0;
    let stopAsked = false;
    let lastText = '';
    let writes = 0;
    let sessionId = null;
    let usage = null;
    const toolNames = new Map();
    let lastLine = Date.now();
    let chain = Promise.resolve();
    let finish;
    const done = new Promise((r) => { finish = r; });
    const hard = setTimeout(() => killTree(p.child), timeoutMs);
    const idle = setInterval(() => { if (Date.now() - lastLine > inactivityMs) killTree(p.child); }, 5000);
    const ask = async (step, tool, input) => {
      if (await onStep(step, steps, handle.draft, tool, input) && !stopAsked) { stopAsked = true; killTree(p.child); }
    };
    const onLine = async (line) => {
      lastLine = Date.now();
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      sessionId = sessionIdOf(msg) ?? sessionId;
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          partialTool = ev.content_block.name ?? null;
          partial = '';
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && partialTool && /(board_(reply|ask|comment)|chat_reply)$/.test(partialTool)) {
          partial += ev.delta.partial_json ?? '';
          const d = draftOf(partial);
          if (d && Date.now() - lastDraftAt >= draftEveryMs) {
            handle.draft = d;
            lastDraftAt = Date.now();
            await ask(null);
          }
        }
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'text' && c.text) lastText = c.text;
          if (c.type !== 'tool_use' || !c.name) continue;
          toolNames.set(c.id, c.name);
          if (/(board_(reply|ask|comment)|chat_reply)$/.test(c.name)) handle.draft = draftOf(JSON.stringify(c.input ?? {})) ?? handle.draft;
          const s = stepLabel(c.name, c.input ?? {});
          steps.push(s);
          await ask(s, c.name, c.input ?? {});
        }
      } else if (msg.type === 'user') {
        for (const c of msg.message?.content ?? []) {
          if (c.type !== 'tool_result') continue;
          const name = toolNames.get(c.tool_use_id) ?? '';
          const text = Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(c.content ?? '');
          if (!c.is_error && WRITE_TOOLS.test(name)) writes++;
          onToolResult(c.tool_use_id, !!c.is_error, text, name);
        }
      } else if (msg.type === 'result') {
        result = { text: msg.result ?? lastText ?? '', error: !!msg.is_error };
        if (msg.usage) usage = { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0, cacheRead: msg.usage.cache_read_input_tokens ?? 0,
          cacheWrite: msg.usage.cache_creation_input_tokens ?? 0, ...(msg.total_cost_usd != null ? { costUsd: msg.total_cost_usd } : {}) };
        // Done: let the process go (it would wait for a next message forever).
        try { p.child.stdin.end(); } catch { /* gone */ }
        setTimeout(() => killTree(p.child), 1500).unref?.();
      }
    };
    p.push = (line) => { chain = chain.then(() => onLine(line)).catch(() => {}); };
    for (const line of p.lines.splice(0)) p.push(line);
    const end = async () => {
      await chain;
      clearTimeout(hard);
      clearInterval(idle);
      this.active.delete(p);
      finish({ steps, result, stderr: p.stderr, stopAsked, writes, error: p.error, sessionId, usage });
    };
    if (p.ended) end();
    else p.waiters.push(end);
    // Resolve as soon as the result is in, without waiting for the process to exit (a late close costs ~1 s).
    const earlyDone = () => { if (result && !p.ended) { p.ended = true; for (const w of p.waiters.splice(0)) w(); } };
    const probe = setInterval(() => { earlyDone(); if (p.ended) clearInterval(probe); }, 200);
    const message = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
    try { p.child.stdin.write(message); } catch (error) { p.error = error; p.ended = true; end(); }
    handle.done = done;
    return handle;
  }

  close() {
    this.closed = true;
    for (const p of [...this.warm, ...this.active]) killTree(p.child);
    this.warm = [];
  }
}

/**
 * One run on a transient process - the shape the runners used before the pool, kept for them and the tests: the
 * options are the pool's plus prompt and the callbacks; returns { draft, kill, done }.
 */
export function runClaude(o) {
  const pool = o.pool ?? new ClaudePool({ ...o, size: 0, warm: false });
  const p = pool.acquire();
  const handle = pool.run(p, o.prompt, { onStep: o.onStep, onToolResult: o.onToolResult, timeoutMs: o.runTimeoutMs, inactivityMs: o.inactivityMs, draftEveryMs: o.draftEveryMs });
  if (!o.pool) handle.done.then(() => pool.close());
  return handle;
}

// ------------------------------------------------------------------------------------------------------ the reporter

/**
 * Reports one run's state to the card (PUT /board/live-work): the latest state only, one request in flight, flushed
 * every 250 ms while something changed and every second while a run works (so the user's Stop is read within a second
 * and Alfred's 5-minute stale clock is reset) - the stream reader never waits for the network.
 */
export class Reporter {
  constructor(alfred, base, { every = 250, tick = 1000, onError = () => {}, onStop = null, path = '/board/live-work' } = {}) {
    this.onStop = onStop;
    this.path = path;
    this.alfred = alfred;
    this.base = base;
    this.every = every;
    this.latest = null;
    this.inFlight = null;
    this.timer = null;
    this.stop = false;
    this.ended = false;
    this.onError = onError;
    // The tick re-sends the last state even when nothing changed: that is how Stop is read while the model thinks.
    this.ticker = setInterval(() => { if (this.ended || this.inFlight) return; if (!this.latest && this.lastBody) this.latest = this.lastBody; if (this.latest) this.flush(); }, tick);
    this.ticker.unref?.();
  }

  static clamp(body) {
    return {
      ...body,
      ...(body.steps ? { steps: body.steps.slice(-40).map((s) => String(s).slice(0, 300)) } : {}),
      ...(body.draft != null ? { draft: String(body.draft).slice(0, 16_000) } : {}),
      ...(body.outcome != null ? { outcome: String(body.outcome).slice(0, 480) } : {}),
      ...(body.head != null ? { head: String(body.head).slice(0, 200) } : {}),
    };
  }

  /** Remembers the state; it goes out now when nothing went out lately (the first "working" shows at once), else at the next flush. */
  report(body) {
    this.latest = { ...this.base, ...body };
    if (!this.inFlight && Date.now() - (this.lastSent ?? 0) >= this.every) { this.flush(); return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.every);
  }

  /** Sends the latest state now and waits for Alfred's answer (the Stop flag). */
  async flush() {
    if (!this.latest) return this.stop;
    if (this.inFlight) { await this.inFlight; if (!this.latest) return this.stop; }
    const body = Reporter.clamp(this.latest);
    this.latest = null;
    this.lastBody = body;
    this.lastSent = Date.now();
    this.inFlight = this.alfred.call('PUT', this.path, { body, timeoutMs: 10_000 })
      .then((r) => { if (r?.stop && !this.stop) { this.stop = true; this.onStop?.(); } return r; })
      .catch((error) => { this.onError(error); return null; })
      .finally(() => { this.inFlight = null; });
    await this.inFlight;
    return this.stop;
  }

  /** The final state: sent now, then nothing more. */
  async end(body) {
    this.report(body);
    await this.flush();
    if (this.inFlight) await this.inFlight;
    this.ended = true;
    clearInterval(this.ticker);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

// ------------------------------------------------------------------------------------------------------- the runner

/** Files of a runner on this machine, one set per Alfred and project (or cycle). */
/**
 * Asks every running /alfred-listen on this Alfred (and project) to stop its live lane only: its stop file reads
 * "live-off" (the listen runner reads it within 2 s). Returns the cycles asked.
 */
export function listenLanesOff(url, project) {
  const dir = join(tmpdir(), 'alfred-listen');
  const out = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.pid.json')); } catch { return out; }
  for (const name of names) {
    try {
      const p = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (p.alfred !== url || (project && p.project && p.project !== project) || !alive(Number(p.pid))) continue;
      writeFileSync(join(dir, name.replace(/\.pid\.json$/, '.stop')), 'live-off');
      out.push(p.cycleId ?? name);
    } catch { /* not a runner's file */ }
  }
  return out;
}

export function files(url, project, kind = 'alfred-live', chatId = null) {
  const dir = join(tmpdir(), kind);
  mkdirSync(dir, { recursive: true });
  const key = `${url}|${project ?? ''}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80);
  // a terminal session that answers a cycle has its own chat log: after a hand-over the old one hears nothing more
  const own = chatId ? `.${String(chatId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}` : '';
  return { dir, key, log: join(dir, `${key}.log`), chat: join(dir, `${key}${own}.chat.log`), pid: join(dir, `${key}.pid.json`), mcp: join(dir, `${key}.mcp.json`),
    cursor: join(dir, `${key}.cursor.json`), system: join(dir, `${key}.system.md`) };
}

export class Runner {
  /**
   * @param o {{ alfred: Alfred, server: string, mcpEntry: object, project?: string, cycleId?: string, model?: string,
   *   cwd: string, claude?: string, claudeArgs?: string[], log: (line: string) => void, chat?: (line: string) => void,
   *   settleMs?: number, waitSeconds?: number, runTimeoutMs?: number, draftEveryMs?: number, host?: string,
   *   mcpConfigFile: string, mcp?: McpClient, pool?: ClaudePool, parallel?: number, kind?: 'live'|'listen',
   *   standDownForLive?: boolean, cursorFile?: string, systemPromptFile?: string }}
   */
  constructor(o) {
    this.o = o;
    this.stopped = false;
    this.handles = new Set();
    this.inFlight = new Map(); // card key -> { promise, queued: changes[] }
    this.waiting = []; // cards past the parallel limit: { key, changes, reporter }
    this.lastSaid = null;
    this.lastHostCheck = 0;
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { [o.server]: o.mcpEntry } }));
    this.pool = o.pool ?? new ClaudePool({ size: o.parallel ?? 3, claude: o.claude, claudeArgs: o.claudeArgs, cwd: o.cwd, server: o.server,
      mcpConfigFile: o.mcpConfigFile, model: o.model, systemPromptFile: o.systemPromptFile, warm: false,
      tools: ['Read', 'Grep', 'Glob', 'Bash'], allowed: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(codegraph explore:*)'],
      only: LIVE_TOOLS, serverTools: o.serverTools });
    this.ownPool = !o.pool;
    this.warmLater = o.warm !== false && !o.pool;
    this.sleepers = new Set();
    this.lastChatAlive = true;
    // specs/022: the board chat - its own pool, whose runs keep their session (a chat continues it)
    this.chatPool = (o.kind ?? 'live') === 'listen' || o.chats === false ? null : o.chatPool ?? new ClaudePool({ size: 2, claude: o.claude, claudeArgs: o.claudeArgs,
      cwd: o.cwd, server: o.server, mcpConfigFile: o.mcpConfigFile, model: o.model, systemPromptFile: o.systemPromptFile, warm: false, persist: true,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'], allowed: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
        'Bash(codegraph explore:*)', 'Skill'],
      only: chatTools(), serverTools: o.serverTools });
    this.chatLane = this.chatPool ? new ChatLane(this, this.chatPool) : null;
  }

  /** A pause that a stop ends at once. */
  sleep(ms) {
    return new Promise((r) => {
      const done = () => { clearTimeout(t); this.sleepers.delete(done); r(); };
      const t = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  /**
   * The board's ▶ (docs/board.md "Run from the board"): waits for a run the user queued for this chat's cycle - woken by
   * the request, no polling - and puts it in the chat (its chat log line). The chat takes it with board_run_take when its
   * turn is free, runs it and ends it with board_run_end; nothing runs here.
   */
  async skillLoop() {
    if (!this.o.chatId || !this.o.cycleId) return; // no chat to hand runs to: ▶ on the board copies the prompt
    while (!this.stopped) {
      try {
        if (this.standingDown) { await this.sleep(5000); continue; }
        const wait = this.o.skillWaitSeconds ?? 50;
        const taken = await this.o.alfred.call('POST', '/board/skill-runs/claim', {
          body: { chatId: this.o.chatId, host: this.o.host ?? hostname(), max: 10, waitSeconds: wait },
          timeoutMs: (wait + 15) * 1000,
        });
        if (this.stopped) {
          // taken after the stop: back to the queue for the cycle's next chat
          for (const run of taken ?? []) await this.o.alfred.call('PUT', `/board/skill-runs/${encodeURIComponent(run.id)}`, { body: { state: 'QUEUED' } }).catch(() => null);
          break;
        }
        for (const run of taken ?? []) {
          this.o.log(`▶ ${run.command} - from the board, sent to the chat${run.note ? ` (note: ${run.note.slice(0, 120)})` : ''}`);
          this.o.chat?.(boardRunLine(run));
        }
      } catch (error) {
        if (this.stopped) break;
        if (error?.status === 404 || error?.status === 405) { await this.sleep(60_000); continue; } // an older Alfred: no board runs
        this.o.log(`  ⚠ board runs: ${error.message} - again in 5 s`);
        await this.sleep(5000);
      }
    }
  }

  /**
   * A line for the session's chat as well as the log: the session watches only the chat log and every line there costs
   * it a turn, so only what adds to the investigation goes there - the answers, failures, start and stop. A warning
   * repeated in a row is said once.
   */
  say(line) {
    this.o.log(line);
    if (line.trimStart().startsWith('⚠') && line === this.lastSaid) return;
    this.lastSaid = line;
    this.o.chat?.(line);
  }

  /** The heartbeat; with a chat it also says this chat handles the cycle and whether the chat is still open (its process runs). */
  beat(stopped = false) {
    const chatAlive = this.o.chatPid ? alive(Number(this.o.chatPid)) : true;
    if (!chatAlive && this.lastChatAlive) this.o.log('  ⚠ the chat that started this runner seems closed - the board says so; ▶ runs wait for it');
    this.lastChatAlive = chatAlive;
    // a runner whose chat stays closed ends: nobody reads its answers there, and the board kept saying "Answering you"
    // for a day after the terminal was gone
    this.chatGoneAt = chatAlive ? null : this.chatGoneAt ?? Date.now();
    if (!stopped && !this.stopped && chatGone(this.chatGoneAt, this.o.chatGoneMs)) {
      this.say(`● The chat that started this runner has been closed for ${Math.round((Date.now() - this.chatGoneAt) / 60_000)} min - stopping.`
        + ' Run /alfred-live again from an open chat to answer the board.');
      this.stop();
      return Promise.resolve(null);
    }
    return this.o.alfred.call('PUT', '/board/live-runner', {
      body: { project: this.o.project ?? '', host: this.o.host ?? hostname(), model: this.o.model ?? null, stopped, kind: this.o.kind ?? 'live',
        ...(this.o.chatId && this.o.cycleId ? { cycleId: this.o.cycleId, chatId: this.o.chatId, cwd: this.o.cwd ?? null, chatAlive,
          ...(this.chatLane?.terminalAt ? { terminalAt: this.chatLane.terminalAt } : {}) } : {}) },
      timeoutMs: 10_000,
    }).catch(() => null);
  }

  /** The open boards this runner's cycle is on (their chats are kept under the board id). */
  async boardsOfCycle() {
    const boards = await this.o.alfred.call('GET', '/board/boards', { query: { project: this.o.project ?? '', state: 'OPEN' }, timeoutMs: 10_000 })
      .catch(() => null);
    return Array.isArray(boards)
      ? boards.filter((b) => b?.board?.id !== this.o.cycleId && (b?.cycleIds ?? []).includes(this.o.cycleId)).map((b) => b.board.id)
      : [];
  }

  /** Whether another runner holds this board: /alfred-live on another machine, or a live runner while this is listen's lane. */
  async anotherOwner() {
    if (this.o.chatId && this.o.cycleId) {
      // One chat per cycle is Alfred's rule (409 at start), so several cycles may run at once - but that one chat may run
      // /alfred-live AND /alfred-listen for the cycle: then both answered every comment (specs/019). The listen lane stands down.
      if ((this.o.kind ?? 'live') !== 'listen') return null;
      // /alfred-live may hold the cycle's chat, or the chat of a board the cycle is on (a board's chat is kept under the
      // board id, specs/027): asking only about this cycle's own chat let both answer every change on the board.
      for (const scope of [this.o.cycleId, ...await this.boardsOfCycle()]) {
        const c = await this.o.alfred.call('GET', '/board/cycle-chat', { query: { cycleId: scope, project: this.o.project ?? '' }, timeoutMs: 10_000 })
          .catch(() => null);
        if (!c?.chat?.kinds?.includes('live')) continue;
        const r = await this.o.alfred.call('GET', '/board/live-runner', { query: { project: this.o.project ?? '', kind: 'live' }, timeoutMs: 10_000 })
          .catch(() => null);
        return r ?? { kind: 'live', host: c.chat.host };
      }
      return null;
    }
    const r = await this.o.alfred.call('GET', '/board/live-runner', { query: { project: this.o.project ?? '' }, timeoutMs: 10_000 }).catch(() => null);
    if (!r) return null;
    const me = this.o.host ?? hostname();
    if (this.o.kind === 'listen' && r.kind && r.kind !== 'listen') return r; // a real /alfred-live answers
    if ((r.kind ?? 'live') !== (this.o.kind ?? 'live')) return (this.o.kind ?? 'live') === 'live' ? null : r;
    return r.host !== me ? r : null;
  }

  /** Stop at once: the runs are killed and (unless told not to - the listen runner's graceful stop) the wait for changes is cut short. */
  stop(abort = true) {
    this.stopped = true;
    for (const wake of [...(this.sleepers ?? [])]) wake();
    for (const h of this.handles) h.kill();
    const waiting = this.waiting;
    this.waiting = [];
    if (abort) this.o.alfred.abort?.();
    // calls made after abort() work: no "waiting its turn" row outlives the runner
    for (const w of waiting) w.reporter.end({ steps: [], state: 'STOPPED', outcome: 'the runner stopped before its turn' }).catch(() => null);
  }

  /** Resolves once every answer in flight has ended (the tests, and the listen runner's stop). */
  async idle() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()].map((v) => v.promise));
  }

  loadCursor() {
    try {
      const c = JSON.parse(readFileSync(this.o.cursorFile, 'utf8'));
      if (Date.now() - Date.parse(c.at) < 15 * 60_000 && c.cursor) return c.cursor;
    } catch { /* none */ }
    return 'now';
  }

  saveCursor(cursor) {
    if (!this.o.cursorFile) return;
    try { writeFileSync(this.o.cursorFile, JSON.stringify({ cursor, at: new Date().toISOString() })); } catch { /* best effort */ }
  }

  async run() {
    let cursor = chatsFromStart(this.o.cursorFile ? this.loadCursor() : 'now');
    // specs/020: ask first who answers this board - announcing first left a window where both answered
    const first = this.o.kind === 'listen' ? await this.anotherOwner() : null;
    this.lastHostCheck = Date.now();
    if (first) {
      this.standingDown = true;
      this.say(`● ${answererName(first)} already answers ${this.o.project || 'this board'} from ${first.host ?? 'another machine'}`
        + ' - listen checks calls only, its live lane stays off until that one stops.');
    } else {
      this.say(`● Live on for ${this.o.project || 'every board'}${this.o.cycleId ? ` (cycle ${this.o.cycleId})` : ''} at ${this.o.alfred.url}`
        + ` - answering on the board from ${this.o.host ?? hostname()}${this.o.kind === 'listen' ? " (/alfred-listen's live lane)" : ''}; each answer shows here.`);
      await this.beat();
    }
    await this.prepare();
    await this.chatLane?.start();
    const beats = setInterval(() => { if (!this.stopped && !this.standingDown) this.beat(); }, 20_000);
    beats.unref?.();
    const skills = this.o.boardRuns === false ? Promise.resolve() : this.skillLoop();
    while (!this.stopped) {
      try {
        cursor = await this.once(cursor);
        this.saveCursor(cursor);
      } catch (error) {
        if (this.stopped) break;
        this.say(`  ⚠ ${error.message} - retrying in 5 s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    clearInterval(beats);
    this.chatLane?.stop();
    await Promise.allSettled([...this.inFlight.values()].map((v) => v.promise));
    if (this.chatLane) await Promise.allSettled([...this.chatLane.chains.values()]);
    await skills;
    await this.beat(true);
    if (this.ownPool) this.pool.close();
    if (this.chatPool && !this.o.chatPool) this.chatPool.close();
    this.say('● Live stopped.');
  }

  /** The server's tool list (so the runs load only what they need) and the warm processes - once, at start. */
  async prepare() {
    if (this.ownPool && this.o.mcp && !this.pool.o.serverTools) {
      const tools = await this.o.mcp.listTools().catch(() => null);
      if (tools?.length) {
        this.pool.o.serverTools = tools;
        this.pool.o.only = LIVE_TOOLS;
        if (this.chatPool) { this.chatPool.o.serverTools = tools; this.chatPool.o.only = chatTools(); }
      }
    }
    if (this.warmLater) { this.pool.size = this.o.parallel ?? 3; this.pool.warmSize = Math.min(this.pool.size, this.o.warmSize ?? 1); this.pool.fill(); this.warmLater = false; }
  }

  /** One wait for the user's changes, then one answer per touched card (in parallel, up to the limit); returns the next cursor. */
  async once(cursor) {
    const { alfred } = this.o;
    const query = { project: this.o.project, cycleId: this.o.cycleId, actor: 'USER' };
    const wait = this.o.waitSeconds ?? 50;
    let page = await alfred.call('GET', '/board/changes/wait', { query: { ...query, cursor, timeoutSeconds: wait }, timeoutMs: (wait + 10) * 1000 });
    if (this.stopped) return cursor;
    if (Date.now() - this.lastHostCheck > 60_000) {
      this.lastHostCheck = Date.now();
      const other = await this.anotherOwner();
      if (other && !this.standingDown) {
        this.standingDown = true;
        this.say(`  ⚠ ${answererName(other)} answers this board from ${other.host} - standing down until it stops`);
      } else if (!other && this.standingDown) {
        this.standingDown = false;
        this.say('  ● the other runner stopped - answering again');
        await this.beat();
        // the chat messages skipped while standing down are still waiting: read them again from the start
        const fresh = await alfred.call('GET', '/board/changes', { query: { ...query, cursor: chatsFromStart(cursor), limit: 200 } }).catch(() => null);
        if (fresh) page = { ...page, chats: fresh.chats ?? page.chats };
      }
    }
    const chats = page.chats ?? [];
    if (!page.entries.length && !page.cycles.length && !chats.length) return page.cursor;
    if (this.standingDown) return page.cursor;
    // The chat's messages are answered in their own lane (urgent first); a page with only those needs no settle.
    if (chats.length && this.chatLane) this.chatLane.handle(chats);
    if (!page.entries.length && !page.cycles.length) return page.cursor;
    // A short settle so a burst (type an answer, then move the card) is one answer, not two: re-read while more arrives.
    const settle = this.o.settleMs ?? 1200;
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, Math.min(300, settle)));
      const again = await alfred.call('GET', '/board/changes', { query: { ...query, cursor, limit: 200 } }).catch(() => page);
      const grew = again.entries.length > page.entries.length || again.cycles.length > page.cycles.length;
      page = again;
      if (!grew || Date.now() - started >= settle) break;
    }
    const paused = await this.pausedFor(page.entries);
    const groups = byCard(page.entries).filter((changes) => !paused.has(changes[0].project));
    if (paused.size) {
      // Paused on the live strip: keep the cursor before these changes so they are answered after the resume.
      this.say('  ⚠ ⏸ paused on the board - your changes are answered when you resume');
      this.o.log(`  ⏸ paused on the board - ${page.entries.length} change(s) wait for the resume`);
      await new Promise((r) => setTimeout(r, 3000));
      return cursor;
    }
    for (const changes of groups) this.dispatch(changes);
    return page.cursor;
  }

  /** The projects of these changes that are paused on the live strip (an every-board runner checks each project once). */
  async pausedFor(entries) {
    const out = new Set();
    const projects = [...new Set(entries.map((e) => e.project ?? ''))];
    await Promise.all(projects.map(async (project) => {
      const status = await this.o.alfred.call('GET', '/board/agent-status', { query: { project }, timeoutMs: 10_000 }).catch(() => null);
      if (status?.state === 'PAUSED') out.add(project);
    }));
    return out;
  }

  /** Starts (or queues) the answer for one card: a card already being answered gets its new changes in a follow-up run. */
  dispatch(changes, rowId = null) {
    const key = `${changes[0].project}\u0000${changes[0].number}`;
    const running = this.inFlight.get(key);
    if (running) {
      running.queued.push(...changes);
      // its card's own run picks these up: the row that waited for them ends here, not never
      if (rowId) new Reporter(this.o.alfred, { id: rowId, project: changes[0].project, cardNumber: changes[0].number, head: 'waiting its turn' })
        .end({ steps: [], state: 'DONE', outcome: 'joined the run already working on this card' }).catch(() => null);
      return;
    }
    const limit = this.o.parallel ?? 3;
    if (this.inFlight.size >= limit) {
      // Visible and stoppable while it waits.
      const id = rowId ?? randomUUID();
      const reporter = new Reporter(this.o.alfred, { id, project: changes[0].project, cardNumber: changes[0].number, head: 'waiting its turn' });
      reporter.report({ steps: [], state: 'WORKING' });
      this.waiting.push({ key, changes, reporter, id });
      return;
    }
    const entry = { queued: [], promise: null };
    this.inFlight.set(key, entry);
    entry.promise = (async () => {
      try {
        await this.answer(changes, 0, rowId);
        while (entry.queued.length && !this.stopped) {
          const next = entry.queued.splice(0);
          await this.answer(next);
        }
      } catch (error) {
        this.say(`  ⚠ #${changes[0].number}: ${error.message}`);
      } finally {
        this.inFlight.delete(key);
        const w = this.waiting.shift();
        if (w && !this.stopped) {
          // the run takes over the waiting row (same id), so one row goes from "waiting its turn" to its end - ended
          // only here, the waiting row stayed WORKING on the board for good
          w.reporter.ended = true;
          clearInterval(w.reporter.ticker);
          this.dispatch(w.changes.length ? [...w.changes] : w.changes, w.id);
        }
      }
    })();
  }

  /** Whether a reply answers one of Claude's questions, and the card's recent thread - from the board, one tool call. */
  async cardContext(changes) {
    const first = changes[0];
    if (!this.o.mcp) return { context: null, answers: await this.questionsOf(changes) };
    try {
      const text = await this.o.mcp.call('board_live_card', { project: first.project, number: first.number,
        changes: changes.map((e) => ({ id: e.id, kind: e.kind, text: e.text, replyTo: e.replyTo, oldValue: e.oldValue, newValue: e.newValue, actor: e.actor, at: e.at })) }, 30_000);
      const json = JSON.parse(text);
      const answers = new Set(changes.filter((e, i) => /^ANSWERS/.test(String(json.userDid?.[i] ?? ''))).map((e) => e.id));
      return { context: json, answers };
    } catch {
      return { context: null, answers: await this.questionsOf(changes) };
    }
  }

  /** Where the card's code is (specs/020), cached per card - one small request for its links. */
  async repoOf(card) {
    this.repos ??= new Map();
    const key = `${card.project}#${card.number}`;
    if (this.repos.has(key)) return this.repos.get(key);
    let hint = null;
    try {
      const detail = await this.o.alfred.call('GET', `/board/cards/by-number/${card.number}`, { query: { project: card.project ?? '' } });
      const paths = codePaths(detail?.links);
      hint = repoHint(paths, findRepo(paths, this.o.cwd ?? process.cwd()));
    } catch {
      hint = null;
    }
    this.repos.set(key, hint);
    return hint;
  }

  /** Whether a reply answers one of Claude's questions - read from the card's thread (one small request). */
  async questionsOf(changes) {
    const replies = changes.filter((e) => e.kind === 'COMMENT' && e.replyTo != null);
    if (!replies.length || !changes[0].cardId) return new Set();
    const entries = [];
    try {
      for (;;) {
        const page = await this.o.alfred.call('GET', `/board/cards/${encodeURIComponent(changes[0].cardId)}/activity`, { query: { offset: entries.length, limit: 1000 } });
        entries.push(...page.entries);
        if (!page.entries.length || entries.length >= page.total) break;
      }
    } catch { /* unknown: read as plain replies */ }
    const questions = new Set(entries.filter((x) => x.actor === 'CLAUDE' && x.kind === 'COMMENT' && String(x.text ?? '').startsWith('**Question**')).map((x) => x.id));
    return new Set(replies.filter((e) => questions.has(e.replyTo)).map((e) => e.id));
  }

  async answer(changes, attempt = 0, rowId = null) {
    const first = changes[0];
    const label = `#${first.number}`;
    if (attempt === 0) for (const e of changes) this.o.log(`${label} "${first.title}"  ${youDid(e)}`);
    const id = rowId ?? randomUUID();
    const started = Date.now();
    const reporter = new Reporter(this.o.alfred, { id, project: first.project, cardNumber: first.number, head: 'working on your change' },
      { every: this.o.reportEveryMs ?? 250, onError: (error) => this.o.log(`  (live-work report failed: ${error.message})`) });
    reporter.report({ steps: [], state: 'WORKING' });
    const { context, answers } = await this.cardContext(changes);
    const { head, quiet } = headOf(changes, (e) => answers.has(e.id));
    reporter.base.head = head;

    if (quiet) {
      const note = `Noted - ${changes.map(youDid).join('; ').replace(/^You /, 'you ')}.`;
      await reporter.end({ steps: changes.map(youDid), state: 'DONE', outcome: note });
      this.o.log(`  → ✦ ${note}`);
      return;
    }

    if (this.o.chatId && this.o.cycleId && this.o.chat && this.chatLane && attempt === 0) {
      // plan-terminal-answers.md: every change on a card of the cycle goes to the terminal session that answers the cycle -
      // the same session as its chat, no copy and no run here; it answers on the card when its turn is free.
      // its progress follows the terminal's transcript until the terminal's reply on the card
      this.chatLane.track({ key: `c:${first.number}`, marker: `✉ #${first.number} `, reporter,
        done: (name, input) => /(^|__)board_reply$/.test(name) && Number(input.number) === first.number });
      this.o.log(`  → ✉ ${label} handed to the terminal session`);
      this.o.chat(cardLine(first, changes, head));
      return;
    }
    if (this.o.chatId && this.o.chat && attempt === 0 && forTheChat(changes)) {
      // Needs the code or an investigation: the chat that handles the cycle answers it, with what it already knows.
      await reporter.end({ steps: changes.map(youDid), state: 'DONE', outcome: 'sent to the chat that handles this cycle - it answers on the card' });
      this.o.log(`  → 💬 ${label} sent to the chat`);
      const repo = await this.repoOf(first);
      this.o.chat(commentLine(first, changes) + (repo ? ` · the code: ${repo.replace(/\s+/g, ' ')}` : ''));
      return;
    }

    reporter.report({ steps: [], state: 'WORKING' });
    this.o.log(`  ✦ ${head} on ${label}…`);
    let refused = null;
    const p = this.pool.acquire();
    const handle = this.pool.run(p, promptFor(this.o.server, first, changes, context, await this.repoOf(first)) + (attempt ? '\n\nYour last try posted no reply: post your answer with board_reply now.' : ''), {
      timeoutMs: this.o.runTimeoutMs ?? 5 * 60_000, draftEveryMs: this.o.draftEveryMs,
      onStep: async (step, steps, draft) => {
        if (step) this.o.log(`    · ${step}`);
        reporter.report({ steps, draft, state: 'WORKING' });
        return reporter.stop;
      },
      onToolResult: (_id, isError, text, name) => { if (isError && WRITE_TOOLS.test(name)) refused = text.slice(0, 200); },
    });
    this.handles.add(handle);
    reporter.onStop = () => handle.kill();
    const { steps, result, stderr, stopAsked, writes } = await handle.done;
    this.handles.delete(handle);
    const draft = handle.draft;

    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const summary = summaryOf(result?.text);
    if (stopAsked || this.stopped) {
      await reporter.end({ steps, draft, state: 'STOPPED', outcome: 'stopped by you' });
      this.o.log(`  ■ ${label} stopped after ${secs} s`);
    } else if (!result || result.error) {
      const why = failureOf(result, stderr);
      const kind = failureKind(why);
      if (!writes && attempt < 2 && kind !== 'auth') {
        const delay = kind === 'limit' ? 10 * 60_000 : attempt === 0 ? 5000 : 30_000;
        await reporter.end({ steps, draft, state: 'WORKING', outcome: `retrying: ${why}` });
        if (kind === 'limit') this.say(`  ⚠ ${label}: usage limit - trying again in 10 min (${why})`);
        else this.o.log(`  ⚠ ${label} failed: ${why} - trying again in ${Math.round(delay / 1000)} s`);
        await new Promise((r) => setTimeout(r, delay));
        if (!this.stopped) return this.answer(changes, attempt + 1);
      }
      await reporter.end({ steps, draft, state: 'FAILED', outcome: why });
      this.say(`  ⚠ ${label} failed: ${why}`);
    } else if (!writes && !/noting|reading your edit|reading why|preparing/.test(head) && attempt === 0 && !refused) {
      // It answered in its own text instead of on the board: once more, told to post it.
      this.o.log(`  ⚠ ${label}: no reply posted - once more`);
      await reporter.end({ steps, draft, state: 'WORKING', outcome: 'no reply posted yet' });
      return this.answer(changes, 1);
    } else if (refused && !writes) {
      await reporter.end({ steps, draft, state: 'FAILED', outcome: `reply refused: ${refused}` });
      this.say(`  ⚠ ${label}: the board refused the reply: ${refused}`);
    } else {
      await reporter.end({ steps, draft, state: 'DONE', outcome: summary ?? 'answered' });
      this.o.log(`  → ✦ Claude (${secs} s): ${draft ?? summary ?? 'answered on the card'}`);
      if (summary && draft) this.o.log(`    ${summary}`);
      // One line for the session: what the user did and what came of it - the reply and what was done beside it.
      const said = (draft ?? '').replace(/\s+/g, ' ').trim();
      const reply = said ? `Claude: ${said.length > 300 ? `${said.slice(0, 300)}…` : said}` : '';
      this.o.chat?.(`${label} "${first.title}" · ${youDid(changes.at(-1))} → ${[reply, summary].filter(Boolean).join(' ') || 'answered on the card'}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    else out._.push(a);
  }
  return out;
}

/** The full log (every step - status shows it) and the chat log (what the session watches: only what adds to it). */
export function writers(f) {
  const stamp = (line) => {
    const t = new Date().toTimeString().slice(0, 8);
    return String(line).split('\n').map((l) => `${t} ${l}`).join('\n') + '\n';
  };
  return { log: (line) => appendFileSync(f.log, stamp(line)), chat: (line) => appendFileSync(f.chat, String(line).replace(/\s*\n\s*/g, ' ') + '\n') };
}

/** How long a runner keeps going after the chat that started it closed (a restart of the terminal comes back sooner). */
export const CHAT_GONE_MS = 30 * 60_000;

/** The chat closed at {@code since} has been gone long enough for its runner to end. */
export function chatGone(since, ms = CHAT_GONE_MS) {
  return since != null && Date.now() - since >= ms;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function running(pidFile) {
  try {
    const s = JSON.parse(readFileSync(pidFile, 'utf8'));
    return alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

export function tail(path, n) {
  try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-n); } catch { return []; }
}

/** The claude command of the CLI arguments: a .mjs/.js path runs through node (the tests' fake). */
export function claudeOf(args) {
  return /\.m?js$/i.test(args.claude ?? '') ? { claude: process.execPath, claudeArgs: [resolve(args.claude)] } : { claude: args.claude ?? 'claude' };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'status';
  const cwd = resolve(args.cwd ?? process.cwd());
  if (!args.server) throw new Error('--server <the Alfred MCP server name> is needed (claude mcp list shows them)');
  const entry = serverEntry(args.server, cwd, args.config); // --config: another Claude Code config (tests)
  const url = args.url ?? alfredUrlOf(entry);
  const project = args.project;
  // the terminal session that answers a cycle: the chat that ran /alfred-live (read from Claude Code's environment)
  const sessionChat = args.cycle ? (args.chat ?? process.env.CLAUDE_CODE_SESSION_ID ?? null) : null;
  const f = files(url, project, 'alfred-live', sessionChat);
  const print = (o) => process.stdout.write(JSON.stringify(o, null, 1) + '\n');

  if (command === 'status') {
    const r = running(f.pid);
    print({ running: !!r, ...(r ?? {}), alfred: url, log: f.log, last: tail(f.log, Number(args.lines ?? 20)) });
    return;
  }
  if (command === 'stop') {
    const r = running(f.pid);
    if (existsSync(f.pid)) unlinkSync(f.pid);
    if (r) { try { process.kill(r.pid); } catch { /* it ends itself: the pid file is gone */ } }
    // frees the cycle at once (the runner's own last beat may come too late, or never)
    const chat = r?.chatId && r?.cycleId ? { cycleId: r.cycleId, chatId: r.chatId } : {};
    await new Alfred(url).call('PUT', '/board/live-runner', { body: { project: project ?? '', host: hostname(), stopped: true, kind: 'live', ...chat } }).catch(() => null);
    // specs/020: the answers may come from /alfred-listen's live lane - "stop answering me" reaches it too; listen keeps checking calls
    const lanes = r ? [] : listenLanesOff(url, project);
    print({ stopped: !!r, ...(lanes.length ? { listenLiveLaneStopped: lanes, note: "the answers came from /alfred-listen's live lane - "
      + 'stopped it; listen keeps checking calls (alfred-listen stop ends listen itself)' } : {}), last: tail(f.log, 5) });
    return;
  }
  if (command === 'start') {
    const r = running(f.pid);
    const chatIdNow = args.chat ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    if (r && args.cycle && chatIdNow && (r.chatId !== chatIdNow || r.cycleId !== args.cycle)) {
      // The newest /alfred-live for a cycle takes it over (plan-terminal-answers.md): the old terminal is told in its own
      // chat log and stops listening; its runner ends and frees the cycle.
      if (r.chat) {
        try {
          appendFileSync(r.chat, `↪ handed over: another terminal session (${String(chatIdNow).slice(0, 8)}) answers ${r.cycleId ? `cycle ${r.cycleId}` : 'this board'}`
            + ' now - this session no longer answers the board chat or its cards; stop watching this log.\n');
        } catch { /* the log is gone: nothing to tell */ }
      }
      if (existsSync(f.pid)) unlinkSync(f.pid);
      try { process.kill(r.pid); } catch { /* it ends itself: the pid file is gone */ }
      await new Alfred(url).call('PUT', '/board/live-runner', { body: { project: project ?? '', host: hostname(), stopped: true, kind: 'live',
        ...(r.chatId && r.cycleId ? { cycleId: r.cycleId, chatId: r.chatId } : {}) } }).catch(() => null);
    } else if (r) {
      print({ alreadyRunning: true, ...r, watch: `tail -n 0 -F "${r.chat ?? f.chat}"`,
        ...(r.cycleId && existsSync(join(f.dir, 'chat-rules.md')) ? { chatRules: join(f.dir, 'chat-rules.md') } : {}) });
      return;
    }
    const alfred = new Alfred(url);
    // The chat that runs this: it owns the cycle, and every ▶ on the cycle's cards goes into it.
    const chatId = args.chat ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    const chatPid = args['chat-pid'] ?? process.env.CLAUDE_PID ?? null;
    const byChat = !!(chatId && args.cycle);
    // Another machine's runner on this board? One answerer per board - unless a chat owns this cycle (one chat per cycle).
    const other = byChat ? null : await alfred.call('GET', '/board/live-runner', { query: { project: project ?? '' } }).catch(() => null);
    if (other && other.host !== hostname() && (other.kind ?? 'live') === 'live' && args.force !== 'true') {
      throw new Error(`/alfred-live already answers this board from ${other.host} (since ${other.startedAt ?? '?'}) - stop it there, or start with --force`);
    }
    // The first heartbeat: Alfred is reachable, new enough to hold it (3.7+), and lets this machine write to its board.
    await alfred.call('PUT', '/board/live-runner', { body: { project: project ?? '', host: hostname(), model: args.model ?? null, stopped: false, kind: 'live',
      ...(byChat ? { cycleId: args.cycle, chatId, cwd, chatAlive: true } : {}) } })
      .catch((error) => {
        throw new Error(/→ 409/.test(error.message) ? error.message.replace(/^.*?→ 409: /, '')
          : /→ (404|500)/.test(error.message) ? `the Alfred at ${url} does not hold the live heartbeat - it is older than /alfred-live needs (3.7): update it (python3 deploy.py, or the installer). It said: ${error.message.replace(/^.*?→ /, '')}`
          : /→ 403/.test(error.message) ? `the Alfred at ${url} does not let this machine edit its board: ${error.message.replace(/^.*→ 403: /, '')}`
            : /fetch failed|timeout|aborted/i.test(error.message) ? `cannot reach Alfred at ${url} from this machine` : error.message);
      });
    writeFileSync(f.log, '');
    writeFileSync(f.chat, '');
    // This session answers the cycle chat itself (plan-terminal-answers.md): the chat's rules, read once before the first ✉
    const chatRules = byChat ? join(f.dir, 'chat-rules.md') : null;
    if (chatRules) writeFileSync(chatRules, CHAT_RULES);
    const self = fileURLToPath(import.meta.url);
    const chatArgs = byChat ? ['--chat', chatId, ...(chatPid ? ['--chat-pid', String(chatPid)] : [])] : [];
    const child = spawn(process.execPath, [self, 'run', ...argv.slice(1), '--cwd', cwd, '--url', url, ...chatArgs], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    const started = { pid: child.pid, alfred: url, project: project ?? null, cycleId: args.cycle ?? null, chatId: byChat ? chatId : null, model: args.model ?? null,
      parallel: Number(args.parallel ?? 3), log: f.log, chat: f.chat, startedAt: new Date().toISOString() };
    writeFileSync(f.pid, JSON.stringify(started));
    print({ started: true, ...started, model: args.model ?? "Claude Code's default", watch: `tail -n 0 -F "${f.chat}"`,
      ...(chatRules ? { chatRules } : {}) });
    return;
  }
  if (command === 'run') {
    const { log, chat } = writers(f);
    process.on('uncaughtException', (error) => log(`  ⚠ ${error.stack ?? error.message}`));
    process.on('unhandledRejection', (error) => log(`  ⚠ ${error?.stack ?? error}`));
    const host = new McpHost(entry, { cwd, log });
    const mcpEntry = await host.start();
    const mcp = new McpClient(mcpEntry, { cwd, name: 'alfred-live' });
    const runner = new Runner({ alfred: new Alfred(url), server: args.server, mcpEntry, project, cycleId: args.cycle, model: args.model,
      cwd, ...claudeOf(args), log, chat, mcpConfigFile: f.mcp, mcp, parallel: Number(args.parallel ?? 3), cursorFile: f.cursor, kind: 'live',
      chatId: args.chat, chatPid: args['chat-pid'], boardRuns: args['no-board-runs'] !== 'true' });
    host.onRestart = (u) => { mcp.entry = { type: 'http', url: u }; mcp.session = null; writeFileSync(f.mcp, JSON.stringify({ mcpServers: { [args.server]: { type: 'http', url: u } } })); };
    const end = (why) => { if (!runner.stopped) log(`  ■ stopping: ${why}`); runner.stop(); };
    process.on('SIGTERM', () => end('SIGTERM'));
    process.on('SIGINT', () => end('SIGINT'));
    process.on('SIGHUP', () => end('SIGHUP'));
    process.on('exit', (code) => { if (!runner.stopped) log(`  ■ process exit ${code} without a stop`); });
    // `stop` removes the pid file: a detached process on Windows cannot be signalled gently, so it ends itself.
    const watch = setInterval(() => { if (!existsSync(f.pid)) end('the pid file is gone (stop)'); }, 2000);
    try {
      await runner.run();
    } finally {
      clearInterval(watch);
      mcp.close();
      host.close();
    }
    return;
  }
  throw new Error(`unknown command "${command}" - start, status or stop`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    process.stderr.write(`alfred-live: ${error.message}\n`);
    process.exit(1);
  });
}
