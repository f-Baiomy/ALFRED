#!/usr/bin/env node
// /alfred-listen's runner (SKILL.md, docs/mcp.md "Listen runner"). Runs on the machine of the Claude session that
// started it, whatever machine Alfred runs on. No dependencies: Node 18+; it shares /alfred-live's runner code, which is
// always installed beside it.
//
//   node alfred-listen.mjs start  --server <mcp name> --cycle <id> --project <p> [--model m] [--dry] [--finish] [--cwd repo]
//   node alfred-listen.mjs status --server <mcp name> --cycle <id>
//   node alfred-listen.mjs stop   --server <mcp name> --cycle <id> [--now]
//
// The runner holds ONE connection to that Alfred MCP server (it starts the stdio server itself, or keeps an HTTP
// session) and calls check_calls itself - waiting for the user's next burst of calls with no model running. check_calls
// remembers what it checked and what is still settling inside that server, so the connection lives as long as the
// listening. A batch that is all clean, with no change of the user's, ends there: counts on the live strip, a line in the
// log. A batch with flagged groups, or the user's comments, starts ONE fresh `claude -p` run that judges it as
// /alfred-review would (batch.md), given the batch and the STATE the last run left - so no conversation grows. Stop
// sweeps (check_calls sweep, in the same connection) and runs review's finish once (finish.md).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const live = await import(pathToFileURL(join(HERE, '..', 'alfred-live', 'alfred-live.mjs')).href).catch(() => {
  throw new Error(`/alfred-live is not installed beside /alfred-listen (${join(HERE, '..', 'alfred-live')}) - reinstall the Alfred skills`);
});
const { Alfred, alfredUrlOf, failureOf, files, parseArgs, runClaude, running, serverEntry, summaryOf, tail, writers } = live;

// -------------------------------------------------------------------------------------------------------- MCP client

/**
 * A minimal MCP client for one server entry of Claude Code's config: stdio (spawns command + args with env) or
 * Streamable HTTP (url). call(name, args) returns the tool's text and throws on a tool error.
 */
export class McpClient {
  constructor(entry, { cwd, name = 'alfred-listen' } = {}) {
    this.entry = entry;
    this.cwd = cwd;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.session = null;
    this.ready = null;
    this.restarts = 0;
  }

  get http() {
    return !!this.entry.url;
  }

  async call(name, args, timeoutMs = 120_000) {
    if (!this.ready) this.ready = this.connect();
    await this.ready;
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) {
      let message = text;
      try { message = JSON.parse(text).message ?? text; } catch { /* plain text */ }
      throw new Error(`${name}: ${message}`);
    }
    return text;
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

  async post(msg, timeoutMs, wantReply, retried = false) {
    const res = await fetch(this.entry.url, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.entry.headers ?? {}),
        ...(this.session ? { 'mcp-session-id': this.session } : {}) },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if ((res.status === 404 || res.status === 400) && this.session && msg.method !== 'initialize' && !retried) {
      // the server forgot the session (restarted): a new one - check_calls' memory is per server process, not per session
      this.session = null;
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

// ----------------------------------------------------------------------------------------------------- batch reading

/** check_calls' machine-readable part: the reply's last line, a JSON object. */
export function batchOf(text) {
  const last = String(text).trimEnd().split('\n').at(-1) ?? '';
  try {
    const json = JSON.parse(last);
    if (json && typeof json === 'object' && !Array.isArray(json)) return json;
  } catch { /* below */ }
  throw new Error(`check_calls answered without its summary line: ${String(text).slice(0, 200)}`);
}

/** The "Clean (n): #.." line of a check_calls reply, if any. */
export function cleanLine(text) {
  return String(text).split('\n').find((l) => l.startsWith('Clean (')) ?? null;
}

/** Whether a batch needs the model: a flagged group, the user's changes (unless /alfred-live answers them), a brief change. */
export function needsRun(json) {
  const board = json.board ?? {};
  const userChanges = (board.changes?.length ?? 0) > 0 && !board.live;
  return (json.totalGroups ?? 0) > 0 || userChanges || (board.cycleChanges?.length ?? 0) > 0;
}

/** The STATE block a run ends with, capped. */
export function stateOf(text) {
  const all = [...String(text ?? '').matchAll(/<<<STATE\s*\n([\s\S]*?)\n\s*STATE>>>/g)];
  const s = all.at(-1)?.[1]?.trim();
  return s ? s.slice(0, 4000) : null;
}

/** The run's findings for the session: its lines starting "• " (outside STATE), at most eight. */
export function findingsOf(text) {
  return String(text ?? '').replace(/<<<STATE[\s\S]*?STATE>>>/g, '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('• ')).slice(0, 8);
}

/** How many cards a tool call adds. */
export function cardsAddedBy(tool, input) {
  const name = String(tool).replace(/^mcp__.+?__/, '');
  if (name === 'board_add') return 1;
  if (name === 'board_add_many') return Array.isArray(input?.cards) ? input.cards.length : 0;
  return 0;
}

// ------------------------------------------------------------------------------------------------------- the runner

export class ListenRunner {
  /**
   * @param o {{ alfred: Alfred, mcp: McpClient, server: string, mcpEntry: object, cycleId: string, project: string,
   *   cwd: string, claude: string, claudeArgs?: string[], model?: string, dry?: boolean, log: (l: string) => void,
   *   mcpConfigFile: string, stateFile: string, skillDir?: string, waitSec?: number, settleSec?: number,
   *   runTimeoutMs?: number, host?: string }}
   */
  constructor(o) {
    this.o = o;
    this.stopping = false;
    this.now = false;
    this.child = null;
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { [o.server]: o.mcpEntry } }));
    this.s = this.load();
  }

  /** A line for the session's chat as well as the log (as /alfred-live's say): findings, failures, start, stop. */
  say(line) {
    this.o.log(line);
    if (line.trimStart().startsWith('⚠') && line === this.lastSaid) return;
    this.lastSaid = line;
    this.o.chat?.(line);
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.o.stateFile, 'utf8'));
    } catch {
      return { lastCallId: null, boardCursor: 'now', batch: 0, checked: 0, flagged: 0, groups: 0, cards: 0, runs: 0, state: null, cleanSince: [] };
    }
  }

  save() {
    writeFileSync(this.o.stateFile, JSON.stringify(this.s));
  }

  /** Stop: finish (sweep + review's finish) after the current wait, or at once with now. */
  stop(now = false) {
    this.stopping = true;
    if (now) {
      this.now = true;
      this.child?.kill();
    }
  }

  async status(step, state = 'WATCHING') {
    const r = await this.o.alfred.call('PUT', '/board/agent-status', {
      body: { project: this.o.project, cycleId: this.o.cycleId, state, callsChecked: this.s.checked, cardsAdded: this.s.cards, step: step?.slice(0, 200) },
    }).catch(() => null);
    return r?.state === 'PAUSED';
  }

  counts() {
    return `${this.s.checked} calls · ${this.s.flagged} flagged in ${this.s.groups} group${this.s.groups === 1 ? '' : 's'} · ${this.s.cards} card${this.s.cards === 1 ? '' : 's'}`;
  }

  /** check_calls, every page of one batch; returns the whole text and the first page's summary. */
  async checkAll(args) {
    const first = await this.o.mcp.call('check_calls', { cycle: this.o.cycleId, ...args }, ((args.waitSec ?? 0) + 120) * 1000);
    const json = batchOf(first);
    const texts = [first];
    let next = json.next;
    while (next != null) {
      const page = await this.o.mcp.call('check_calls', { cycle: this.o.cycleId, ...(args.sinceCallId ? { sinceCallId: args.sinceCallId } : {}),
        ...(args.sweep ? { sweep: true } : {}), offset: next, ...(json.lastCallId ? { untilCallId: json.lastCallId } : {}) });
      texts.push(page);
      next = batchOf(page).next;
    }
    return { text: texts.join('\n\n'), json };
  }

  async run() {
    const restartsAtStart = this.o.mcp.restarts;
    this.say(`● Listening to cycle ${this.o.cycleId} (${this.o.project}) on ${this.o.alfred.url} from ${this.o.host ?? hostname()}`
      + ` · no model while calls are clean${this.o.dry ? ' · dry run: nothing is written' : ''}`);
    await this.status(`listening to ${this.o.cycleId} · ${this.counts()}`);
    while (!this.stopping) {
      try {
        await this.once();
        if (this.o.mcp.restarts > restartsAtStart && !this.warnedRestart) {
          this.warnedRestart = true;
          this.say('  ⚠ the MCP server restarted - calls checked before it are re-checked by the sweep at stop');
        }
      } catch (error) {
        if (this.stopping) break;
        this.say(`  ⚠ ${error.message} - retrying in 5 s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!this.now) await this.finish();
    else {
      await this.status(`stopped without the finish - /alfred-listen ${this.o.cycleId} --finish runs it`, 'STOPPED');
      this.say('● Listen stopped without the finish - `/alfred-listen <cycle> --finish` runs it later.');
    }
    this.o.mcp.close();
  }

  /** One batch: wait (no model), check, then either note it or judge it with one run. */
  async once() {
    if (!this.s.lastCallId) {
      // Nothing checked yet: the first batch is every call already in the cycle - or the first ones to come.
      const { text, json } = await this.checkAll({ boardCursor: this.s.boardCursor });
      if (!json.lastCallId) {
        if (json.board?.cursor) this.s.boardCursor = json.board.cursor;
        await this.o.mcp.call('wait_for_calls', { cycleId: this.o.cycleId, timeoutSec: this.o.waitSec ?? 60, settleSec: this.o.settleSec ?? 5 }, 180_000);
        return;
      }
      return this.handle(text, json);
    }
    const { text, json } = await this.checkAll({ sinceCallId: this.s.lastCallId, waitSec: this.o.waitSec ?? 60, settleSec: this.o.settleSec ?? 5,
      boardCursor: this.s.boardCursor });
    if (this.stopping && this.now) return;
    if (!json.checked && !(json.board?.changes?.length) && !(json.board?.cycleChanges?.length)) {
      if (json.board?.cursor) this.s.boardCursor = json.board.cursor;
      return; // nothing arrived: wait again
    }
    return this.handle(text, json);
  }

  async handle(text, json) {
    this.s.batch++;
    this.s.checked += json.checked ?? 0;
    this.s.flagged += json.flaggedCalls ?? 0;
    this.s.groups += json.totalGroups ?? 0;
    if (json.lastCallId) this.s.lastCallId = json.lastCallId;
    if (json.board?.cursor) this.s.boardCursor = json.board.cursor;
    const n = this.s.batch;
    const users = json.board?.changes ?? [];
    const what = [`batch ${n} · ${json.checked ?? 0} calls`,
      json.totalGroups ? `${json.flaggedCalls} flagged in ${json.totalGroups} group${json.totalGroups === 1 ? '' : 's'}` : 'all clean',
      json.rechecked ? `rechecked ${json.rechecked} (late logs / SQL)` : null,
      users.length ? `${users.length} change${users.length === 1 ? '' : 's'} of yours${json.board?.live ? ' (left to /alfred-live)' : ''}` : null,
    ].filter(Boolean).join(' · ');
    for (const u of users) this.o.log(`  ${String(u).slice(0, 300)}`);

    const paused = await this.status(`listening to ${this.o.cycleId} · ${this.counts()}`);
    if (!needsRun(json)) {
      const clean = cleanLine(text);
      if (clean) this.s.cleanSince = [...this.s.cleanSince, `batch ${n}: ${clean}`].slice(-30);
      this.o.log(`${what}      (no run)`);
      this.save();
      return;
    }
    if (paused) {
      // Paused on the live strip: no card is written; the batch waits for the next run (or the sweep at stop).
      this.s.held = [...(this.s.held ?? []), text].slice(-5);
      this.o.log(`${what} · ⏸ paused on the board - judged when you resume`);
      this.say('  ⚠ ⏸ paused on the board - flagged batches are held and judged when you resume');
      this.save();
      return;
    }
    this.o.log(what);
    const texts = [...(this.s.held ?? []), text];
    this.s.held = [];
    await this.judge(`judging batch ${n}`, readPrompt(this.o, 'batch.md'), this.batchPrompt(texts, json), `batch ${n} · ${json.checked ?? 0} calls`);
    this.s.cleanSince = [];
    this.save();
  }

  batchPrompt(texts, json) {
    return [
      `CYCLE: ${this.o.cycleId} · project "${this.o.project}" · the Alfred tools are mcp__${this.o.server}__* · rules.md: ${rulesPath(this.o)}`,
      this.o.dry ? 'DRY RUN (--dry): write nothing on the board; list what you would write.' : '',
      `STATE (from the last run):\n${this.s.state ?? '(none yet - the first batch: read the task with task_context)'}`,
      this.s.cleanSince.length ? `CLEAN BATCHES SINCE THE LAST RUN (mark their steps too):\n${this.s.cleanSince.join('\n')}` : '',
      json.board?.live ? 'THE USER\'S CHANGES: /alfred-live is answering the user - only note them in STATE.' : '',
      `THE BATCH (check_calls output, every page):\n${texts.join('\n\n---\n\n')}`,
    ].filter(Boolean).join('\n\n');
  }

  /** One fresh run; its steps on the live strip and in the log; its STATE kept for the next. */
  async judge(head, rules, body, said = head) {
    const started = Date.now();
    this.o.log(`  ✦ ${head}…`);
    const run = runClaude({ ...this.o, prompt: `${rules}\n\n${body}`, runTimeoutMs: this.o.runTimeoutMs ?? 15 * 60_000,
      onStep: async (step, steps, draft, tool, input) => {
        if (!step) return false;
        this.s.cards += cardsAddedBy(tool, input);
        this.o.log(`    · ${step}`);
        await this.status(`${head} · ${step}`);
        return this.now;
      } });
    this.child = run;
    const { result, stderr, stopAsked } = await run.done;
    this.child = null;
    this.s.runs++;
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    if (stopAsked || this.now) {
      this.o.log(`  ■ ${head} stopped after ${secs} s`);
    } else if (!result || result.error) {
      this.say(`  ⚠ ${head} failed: ${failureOf(result, stderr)}`);
    } else {
      this.s.state = stateOf(result.text) ?? this.s.state;
      const summary = (summaryOf(result.text) ?? '→ judged').replace(/^→\s*/, '');
      this.o.log(`  → ✦ Claude (${secs} s): ${summary}`);
      // For the session: what the batch found, with its evidence - not how long it took or which tools it called.
      this.o.chat?.(`${said} → ${summary}`);
      for (const f of findingsOf(result.text)) this.say(`  ${f}`);
    }
    await this.status(`listening to ${this.o.cycleId} · ${this.counts()}`);
  }

  /** Stop: the sweep in this same connection (what was checked lives here), then review's finish in one run. */
  async finish() {
    this.o.log('■ Stop · sweeping, then review\'s finish (regressions, shapes, marks, session log)…');
    await this.status(`finishing ${this.o.cycleId} · sweep`);
    let sweep;
    try {
      sweep = await this.checkAll({ sweep: true });
      this.s.checked += sweep.json.checked ?? 0;
      this.o.log(`  sweep · ${sweep.json.checked ?? 0} calls never checked or changed since · ${sweep.json.totalGroups ?? 0} group(s)`);
    } catch (error) {
      this.say(`  ⚠ sweep failed: ${error.message}`);
      sweep = { text: `(the sweep failed: ${error.message} - call check_calls with sweep: true yourself)` };
    }
    const held = this.s.held?.length ? `\n\nBATCHES NOT JUDGED (paused on the board):\n${this.s.held.join('\n\n---\n\n')}` : '';
    await this.judge('finishing', readPrompt(this.o, 'finish.md'), [
      `CYCLE: ${this.o.cycleId} · project "${this.o.project}" · the Alfred tools are mcp__${this.o.server}__* · rules.md: ${rulesPath(this.o)}`,
      this.o.dry ? 'DRY RUN (--dry): write nothing on the board; list what you would write.' : '',
      `COUNTS: ${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs`,
      `STATE (from the last run):\n${this.s.state ?? '(none)'}`,
      this.s.cleanSince.length ? `CLEAN BATCHES SINCE THE LAST RUN (mark their steps):\n${this.s.cleanSince.join('\n')}` : '',
      `THE SWEEP (check_calls sweep: true, every page):\n${sweep.text}${held}`,
    ].filter(Boolean).join('\n\n'), 'finish');
    this.s.held = [];
    this.save();
    await this.status(`stopped · ${this.counts()}`, 'STOPPED');
    this.say(`● Listen stopped · ${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs`);
  }
}

function rulesPath(o) {
  const dir = o.skillDir ?? HERE;
  const own = join(dir, 'rules.md');
  return existsSync(own) ? own : join(dir, '..', '_shared', 'rules.md');
}

function readPrompt(o, name) {
  return readFileSync(join(o.skillDir ?? HERE, name), 'utf8');
}

// ------------------------------------------------------------------------------------------------------------- CLI

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'status';
  const cwd = resolve(args.cwd ?? process.cwd());
  if (!args.server) throw new Error('--server <the Alfred MCP server name> is needed (claude mcp list shows them)');
  if (!args.cycle) throw new Error('--cycle <the session cycle id> is needed');
  const entry = serverEntry(args.server, cwd, args.config);
  const url = args.url ?? alfredUrlOf(entry);
  const f = files(url, args.cycle, 'alfred-listen');
  const stateFile = f.pid.replace(/\.pid\.json$/, '.state.json');
  const stopFile = f.pid.replace(/\.pid\.json$/, '.stop');
  const print = (o) => process.stdout.write(JSON.stringify(o, null, 1) + '\n');

  if (command === 'status') {
    const r = running(f.pid);
    print({ running: !!r, ...(r ?? {}), alfred: url, log: f.log, last: tail(f.log, Number(args.lines ?? 20)) });
    return;
  }
  if (command === 'stop') {
    const r = running(f.pid);
    // The runner reads this within 2 s: it finishes (sweep + review's finish) after its current wait, then exits.
    writeFileSync(stopFile, args.now === 'true' ? 'now' : 'finish');
    print({ stopping: !!r, finish: args.now !== 'true', watch: `tail -n 0 -F "${f.chat}"`, last: tail(f.log, 5) });
    return;
  }
  if (command === 'start') {
    if (!args.project) throw new Error('--project <the cycle\'s project> is needed');
    const r = running(f.pid);
    if (r) { print({ alreadyRunning: true, ...r, watch: `tail -n 0 -F "${f.chat}"` }); return; }
    const alfred = new Alfred(url);
    await alfred.call('GET', '/board/agent-status', { query: { project: args.project } }).catch((error) => {
      throw new Error(/fetch failed|timeout|aborted/i.test(error.message) ? `cannot reach Alfred at ${url} from this machine` : error.message);
    });
    if (existsSync(stopFile)) unlinkSync(stopFile);
    if (args.fresh === 'true' && existsSync(stateFile)) unlinkSync(stateFile);
    appendFileSync(f.log, '');
    appendFileSync(f.chat, '');
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'run', ...argv.slice(1), '--cwd', cwd, '--url', url], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    const started = { pid: child.pid, alfred: url, cycleId: args.cycle, project: args.project, model: args.model ?? null,
      dry: args.dry === 'true', finishOnly: args.finish === 'true', log: f.log, chat: f.chat, startedAt: new Date().toISOString() };
    writeFileSync(f.pid, JSON.stringify(started));
    print({ started: true, ...started, model: args.model ?? "Claude Code's default", watch: `tail -n 0 -F "${f.chat}"` });
    return;
  }
  if (command === 'run') {
    const { log, chat } = writers(f);
    const mcp = new McpClient(entry, { cwd });
    const runner = new ListenRunner({ alfred: new Alfred(url), mcp, server: args.server, mcpEntry: entry, cycleId: args.cycle, project: args.project,
      // --claude: another Claude Code command (a script path runs through node - the tests' fake)
      cwd, chat, ...(/\.m?js$/i.test(args.claude ?? '') ? { claude: process.execPath, claudeArgs: [resolve(args.claude)] } : { claude: args.claude ?? 'claude' }),
      model: args.model, dry: args.dry === 'true', log, mcpConfigFile: f.mcp, stateFile,
      waitSec: args.wait ? Number(args.wait) : undefined, settleSec: args.settle ? Number(args.settle) : undefined });
    const onStop = () => {
      if (!existsSync(stopFile)) return;
      const how = readFileSync(stopFile, 'utf8').trim();
      unlinkSync(stopFile);
      runner.stop(how === 'now');
    };
    process.on('SIGTERM', () => runner.stop(true));
    process.on('SIGINT', () => runner.stop(true));
    const watch = setInterval(onStop, 2000);
    if (args.finish === 'true') runner.stop(false);
    try {
      await runner.run();
    } finally {
      clearInterval(watch);
      if (existsSync(f.pid)) unlinkSync(f.pid);
      if (!runner.now && existsSync(stateFile)) unlinkSync(stateFile); // finished: the next listen starts fresh
    }
    return;
  }
  throw new Error(`unknown command "${command}" - start, status or stop`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    process.stderr.write(`alfred-listen: ${error.message}\n`);
    process.exit(1);
  });
}
