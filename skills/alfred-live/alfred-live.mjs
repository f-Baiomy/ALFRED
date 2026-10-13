#!/usr/bin/env node
// /alfred-live's runner (SKILL.md, docs/mcp.md "Live answers"). Runs on the machine of the Claude session that started
// it - next to the app's repo and that machine's Claude Code - whatever machine Alfred runs on (this one, a LAN host,
// Docker). No dependencies: Node 18+ only, so it ships inside the skill folder.
//
//   node alfred-live.mjs start  --server <mcp name> [--project p] [--cycle id] [--model m] [--cwd repo] [--claude cmd]
//   node alfred-live.mjs status --server <mcp name> [--project p]
//   node alfred-live.mjs stop   --server <mcp name> [--project p]
//
// --server is the Alfred MCP server as Claude Code has it registered ("alfred-lan-83"): its entry in ~/.claude.json
// gives Alfred's address (an http server's url without /mcp, or a stdio server's ALFRED_URL) and is handed as-is to each
// run, so the run uses the same tools the session does. `start` starts the runner in the background and prints where its
// log is; the session watches the log so each event shows in its chat.
//
// The runner waits on Alfred's board for the user's next change with no model running. Each card the user touched is
// either noted (a move to To do / In progress, a close, flags, teams) or answered by ONE fresh `claude -p` run that sees
// only that change - so no conversation grows. The run's stream-json is read as it comes: each tool call becomes a step
// and the reply tool's partial input is the draft, reported to Alfred (PUT /board/live-work) so the card shows Claude
// working - steps, the reply typing in, Stop - while it happens.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ------------------------------------------------------------------------------------------------- what the user did

const pretty = (v) => String(v ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** "You moved it In progress → Fixed" - for the log, the quiet note and the run's prompt. */
export function youDid(e) {
  const text = String(e.text ?? '').replace(/\s+/g, ' ').trim();
  const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  switch (e.kind) {
    case 'COMMENT': return e.replyTo != null ? `You replied: ${short}` : `You: ${short}`;
    case 'STATUS': return `You moved it ${pretty(e.oldValue)} → ${pretty(e.newValue)}`;
    case 'RESOLUTION': return `You closed it as ${pretty(e.newValue)}${short ? ` - ${short}` : ''}`;
    case 'REASON': return `You gave the reason: ${short}`;
    case 'DESCRIPTION': return 'You edited the description';
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
    case 'trace_value': return `tracing "${s('value')}" through the calls`;
    case 'read_spec': case 'get_brief': return 'reading the spec';
    case 'exception_source': case 'locate_source': return 'finding the code line';
    case 'board_reply': case 'board_ask': case 'board_comment': return 'writing the reply';
    case 'board_edit': return `→ editing ${card}${s('kind') ? ` (kind → ${s('kind')})` : ''}`;
    case 'board_add': return `→ adding a card: ${s('title')}`;
    case 'board_add_many': return '→ adding cards';
    case 'board_link': return `→ linking evidence to ${card}`;
    case 'board_link_spec': return `→ linking ${card} to its requirement`;
    case 'board_propose': return `→ proposing ${pretty(s('status') || 'a step')}`;
    case 'board_flag': return `→ flagging ${card}`;
    case 'board_assign': return `→ assigning ${card} to ${Array.isArray(input.teams) ? input.teams.join(', ') : 'teams'}`;
    case 'board_retest_plan': return `→ setting ${card}'s re-test plan`;
    case 'board_move': return `→ moving ${card} to ${pretty(s('status'))}`;
    case 'Read': return `reading ${basename(s('file_path'))}${s('offset') ? `:${s('offset')}` : ''}`;
    case 'Grep': return `searching the code for "${s('pattern')}"`;
    case 'Glob': return `finding files ${s('pattern')}`;
    default: return name.replace(/_/g, ' ');
  }
}

/** The reply text from a reply tool's partial JSON input - shown as it types in. */
export function draftOf(partialJson) {
  const m = /"(?:text|question|did)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (!m) return null;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16))
    : c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

const RULES = `You are Alfred live: you answer the user on the Alfred task board while they work, one change of theirs at a time.
- First board_get the card: its thread with [indexes], the open questions, the evidence. Read nothing else you do not need.
- Answer in the card's thread with board_reply (replyTo = the [index] of the user's comment, or of your question they answered). 1-3 short sentences, plain words, in the user's language. Say what you did, never what you are about to think.
- An answer to your question: reply with what it changes ("Got it - ..."), then do it within the board's limits (board_edit your own Inbox card's kind/description, board_add a BUG with the calls, board_flag, board_assign). A question back only when it is still unclear (board_ask, once).
- A question to you: look it up first (at most three Alfred or code lookups), then answer with the evidence as mentions (@[call:in:<id>|label]).
- A move to Fixed with no re-test plan: board_retest_plan. A dismissed proposal: one board_comment (did/found/next) with what you will do instead. An edit: answer only if it changes your work.
- Never move cards to To do for the user, never close, mark the checklist or set scope - propose (board_propose, board_suggest_mark).
- The app's repo is your working folder: read the code there when the answer needs it. Change no file.
- End with one line: "→ " and what you did (e.g. "→ replied; turned #12 into a BUG").`;

/** The prompt of one run: the rules, which tools, the card and exactly what the user did - nothing else. */
export function promptFor(server, card, changes) {
  return `${RULES}\n\nThe Alfred tools are mcp__${server}__* (e.g. mcp__${server}__board_get).\n\n`
    + `CARD: project "${card.project}" #${card.number} "${card.title}" (${card.status})\n`
    + `WHAT THE USER JUST DID:\n${changes.map((e) => `- ${youDid(e)}${e.replyTo != null ? ' (a reply in a thread - board_get shows which comment)' : ''}`).join('\n')}\n\n`
    + 'Answer this change now.';
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

export class Alfred {
  constructor(url) {
    this.url = url;
  }

  async call(method, path, { query, body, timeoutMs = 20_000 } = {}) {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'X-Alfred-Actor': 'claude', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).message ?? text; } catch { /* plain text */ }
      throw new Error(`Alfred ${method} ${path} → ${res.status}: ${String(message).slice(0, 300)}`);
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

// ------------------------------------------------------------------------------------------------------- the runner

export class Runner {
  /**
   * @param o {{ alfred: Alfred, server: string, mcpEntry: object, project?: string, cycleId?: string, model?: string,
   *   cwd: string, claude: string, claudeArgs?: string[], log: (line: string) => void, settleMs?: number,
   *   waitSeconds?: number, runTimeoutMs?: number, draftEveryMs?: number, host?: string, mcpConfigFile: string }}
   */
  constructor(o) {
    this.o = o;
    this.stopped = false;
    this.child = null;
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { [o.server]: o.mcpEntry } }));
  }

  beat(stopped = false) {
    return this.o.alfred.call('PUT', '/board/live-runner', {
      body: { project: this.o.project ?? '', host: this.o.host ?? hostname(), model: this.o.model ?? null, stopped },
    }).catch(() => null);
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  async run() {
    let cursor = 'now';
    this.o.log(`● Live on for ${this.o.project || 'every board'}${this.o.cycleId ? ` (cycle ${this.o.cycleId})` : ''} at ${this.o.alfred.url}`
      + ` - answering on the board from ${this.o.host ?? hostname()}; each event shows here.`);
    while (!this.stopped) {
      await this.beat();
      try {
        cursor = await this.once(cursor);
      } catch (error) {
        if (this.stopped) break;
        this.o.log(`  ⚠ ${error.message} - retrying in 5 s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    await this.beat(true);
    this.o.log('● Live stopped.');
  }

  async once(cursor) {
    const { alfred } = this.o;
    const query = { project: this.o.project, cycleId: this.o.cycleId, actor: 'USER' };
    const wait = this.o.waitSeconds ?? 50;
    let page = await alfred.call('GET', '/board/changes/wait', { query: { ...query, cursor, timeoutSeconds: wait }, timeoutMs: (wait + 10) * 1000 });
    if (this.stopped || (!page.entries.length && !page.cycles.length)) return page.cursor;
    await new Promise((r) => setTimeout(r, this.o.settleMs ?? 1200));
    page = await alfred.call('GET', '/board/changes', { query: { ...query, cursor, limit: 200 } }).catch(() => page);
    if (this.o.project !== undefined) {
      const status = await alfred.call('GET', '/board/agent-status', { query: { project: this.o.project } }).catch(() => null);
      if (status?.state === 'PAUSED') {
        this.o.log(`  ⏸ paused on the board - ${page.entries.length} change(s) not answered`);
        return page.cursor;
      }
    }
    for (const changes of byCard(page.entries)) {
      if (this.stopped) break;
      await this.answer(changes);
    }
    return page.cursor;
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

  async answer(changes) {
    const first = changes[0];
    const label = `#${first.number}`;
    for (const e of changes) this.o.log(`${label} "${first.title}"  ${youDid(e)}`);
    const answers = await this.questionsOf(changes);
    const { head, quiet } = headOf(changes, (e) => answers.has(e.id));
    const id = randomUUID();
    const started = Date.now();
    const report = (body) => this.o.alfred.call('PUT', '/board/live-work', { body: { id, project: first.project, cardNumber: first.number, head, ...body } })
      .catch(() => ({ stop: false }));

    if (quiet) {
      const note = `Noted - ${changes.map(youDid).join('; ').replace(/^You /, 'you ')}.`;
      await report({ steps: changes.map(youDid), state: 'DONE', outcome: note });
      this.o.log(`  → ✦ ${note}`);
      return;
    }

    const steps = [];
    let draft = null;
    let lastDraftAt = 0;
    let stopAsked = false;
    await report({ steps, state: 'WORKING' });
    this.o.log(`  ✦ ${head} on ${label}…`);

    const args = [...(this.o.claudeArgs ?? []), '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', this.o.mcpConfigFile, '--strict-mcp-config', '--allowedTools', `mcp__${this.o.server}`, 'Read', 'Grep', 'Glob',
      ...(this.o.model ? ['--model', this.o.model] : [])];
    // Windows resolves `claude` (a .cmd / .exe on PATH) only through a shell; the prompt goes on stdin either way.
    const child = spawn(this.o.claude, args, { cwd: this.o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' && !/\.(exe|js|mjs)$/i.test(this.o.claude) && this.o.claude !== process.execPath });
    this.child = child;
    child.stdin.end(promptFor(this.o.server, first, changes));
    const timeout = setTimeout(() => child.kill(), this.o.runTimeoutMs ?? 5 * 60_000);
    let result = null;
    let partial = '';
    let partialTool = null;
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    const stopIf = (r) => { if (r?.stop && !stopAsked) { stopAsked = true; child.kill(); } };

    const onLine = async (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          partialTool = ev.content_block.name ?? null;
          partial = '';
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && partialTool && /board_(reply|ask|comment)$/.test(partialTool)) {
          partial += ev.delta.partial_json ?? '';
          const d = draftOf(partial);
          if (d && Date.now() - lastDraftAt >= (this.o.draftEveryMs ?? 400)) {
            draft = d;
            lastDraftAt = Date.now();
            stopIf(await report({ steps, draft, state: 'WORKING' }));
          }
        }
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type !== 'tool_use' || !c.name) continue;
          if (/board_(reply|ask|comment)$/.test(c.name)) draft = draftOf(JSON.stringify(c.input ?? {})) ?? draft;
          const s = stepLabel(c.name, c.input ?? {});
          steps.push(s);
          this.o.log(`    · ${s}`);
          stopIf(await report({ steps, draft, state: 'WORKING' }));
        }
      } else if (msg.type === 'result') {
        result = { text: msg.result ?? '', error: !!msg.is_error };
      }
    };
    let chain = Promise.resolve();
    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) chain = chain.then(() => onLine(line));
    });
    await new Promise((r) => child.on('close', r));
    if (buffer.trim()) chain = chain.then(() => onLine(buffer));
    await chain;
    clearTimeout(timeout);
    this.child = null;

    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const summary = (result?.text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('→')).at(-1) ?? null;
    if (stopAsked || this.stopped) {
      await report({ steps, draft, state: 'STOPPED', outcome: 'stopped by you' });
      this.o.log(`  ■ ${label} stopped after ${secs} s`);
    } else if (!result || result.error) {
      const why = (result?.text?.trim() || stderr.trim().split('\n').at(-1) || 'the run ended without a result').slice(0, 300);
      await report({ steps, draft, state: 'FAILED', outcome: why });
      this.o.log(`  ⚠ ${label} failed: ${why}`);
    } else {
      await report({ steps, draft, state: 'DONE', outcome: summary ?? 'answered' });
      this.o.log(`  → ✦ Claude (${secs} s): ${draft ?? summary ?? 'answered on the card'}`);
      if (summary && draft) this.o.log(`    ${summary}`);
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

/** This runner's files on this machine, one set per Alfred and project. */
export function files(url, project) {
  const dir = join(tmpdir(), 'alfred-live');
  mkdirSync(dir, { recursive: true });
  const key = `${url}|${project ?? ''}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80);
  return { log: join(dir, `${key}.log`), pid: join(dir, `${key}.pid.json`), mcp: join(dir, `${key}.mcp.json`) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function running(pidFile) {
  try {
    const s = JSON.parse(readFileSync(pidFile, 'utf8'));
    return alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

function tail(path, n) {
  try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-n); } catch { return []; }
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'status';
  const cwd = resolve(args.cwd ?? process.cwd());
  if (!args.server) throw new Error('--server <the Alfred MCP server name> is needed (claude mcp list shows them)');
  const entry = serverEntry(args.server, cwd, args.config); // --config: another Claude Code config (tests)
  const url = args.url ?? alfredUrlOf(entry);
  const project = args.project;
  const f = files(url, project);
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
    await new Alfred(url).call('PUT', '/board/live-runner', { body: { project: project ?? '', host: hostname(), stopped: true } }).catch(() => null);
    print({ stopped: !!r, last: tail(f.log, 5) });
    return;
  }
  if (command === 'start') {
    const r = running(f.pid);
    if (r) { print({ alreadyRunning: true, ...r, watch: `tail -n 0 -F "${f.log}"` }); return; }
    // The first heartbeat: Alfred is reachable, new enough to hold it (3.7+), and lets this machine write to its board.
    await new Alfred(url).call('PUT', '/board/live-runner', { body: { project: project ?? '', host: hostname(), model: args.model ?? null, stopped: false } })
      .catch((error) => {
        throw new Error(/→ (404|500)/.test(error.message) ? `the Alfred at ${url} does not hold the live heartbeat - it is older than /alfred-live needs (3.7): update it (python3 deploy.py, or the installer). It said: ${error.message.replace(/^.*?→ /, '')}`
          : /→ 403/.test(error.message) ? `the Alfred at ${url} does not let this machine edit its board: ${error.message.replace(/^.*→ 403: /, '')}`
            : /fetch failed|timeout|aborted/i.test(error.message) ? `cannot reach Alfred at ${url} from this machine` : error.message);
      });
    writeFileSync(f.log, '');
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'run', ...argv.slice(1), '--cwd', cwd, '--url', url], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    const started = { pid: child.pid, alfred: url, project: project ?? null, cycleId: args.cycle ?? null, model: args.model ?? null,
      log: f.log, startedAt: new Date().toISOString() };
    writeFileSync(f.pid, JSON.stringify(started));
    print({ started: true, ...started, model: args.model ?? "Claude Code's default", watch: `tail -n 0 -F "${f.log}"` });
    return;
  }
  if (command === 'run') {
    const log = (line) => {
      const t = new Date().toTimeString().slice(0, 8);
      appendFileSync(f.log, String(line).split('\n').map((l) => `${t} ${l}`).join('\n') + '\n');
    };
    const runner = new Runner({ alfred: new Alfred(url), server: args.server, mcpEntry: entry, project, cycleId: args.cycle, model: args.model,
      cwd, claude: args.claude ?? 'claude', log, mcpConfigFile: f.mcp });
    const end = () => runner.stop();
    process.on('SIGTERM', end);
    process.on('SIGINT', end);
    // `stop` removes the pid file: a detached process on Windows cannot be signalled gently, so it ends itself.
    const watch = setInterval(() => { if (!existsSync(f.pid)) end(); }, 2000);
    await runner.run();
    clearInterval(watch);
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
