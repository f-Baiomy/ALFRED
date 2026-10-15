#!/usr/bin/env node
// /alfred-listen's runner (SKILL.md, docs/mcp.md "Listen runner"). Runs on the machine of the Claude session that
// started it, whatever machine Alfred runs on. No dependencies: Node 18+; it shares /alfred-live's runner code, which is
// always installed beside it.
//
//   node alfred-listen.mjs start  --server <mcp name> --cycle <id> --project <p> [--model m] [--parallel n] [--dry] [--finish] [--cwd repo]
//   node alfred-listen.mjs status --server <mcp name> --cycle <id>
//   node alfred-listen.mjs stop   --server <mcp name> --cycle <id> [--now]
//
// Three lanes share one MCP server (McpHost), one connection (McpClient) and warm `claude` processes (ClaudePool):
// - The CHECK lane waits for the user's next burst with no model: check_calls (sinceCallId, waitSec, settleSec, every
//   page) in the one connection, where check_calls keeps what it checked and what is still settling. A batch with no
//   flagged group costs no model; a group the ledger already knows (a card still open, a verdict marked recurring) is
//   handled in code (board_link, a count); the rest becomes a judge job.
// - JUDGE jobs run in parallel (--parallel), each ONE fresh run (batch.md in the system prompt, the context pack and
//   the batch in the user prompt) that judges the batch as review would and ends with LEDGER / UNSURE / CODE / CHECK /
//   STATE blocks the runner keeps. A job whose run fails stays in the persisted queue and is tried again (a usage limit
//   waits, a too-long prompt is split); a group the run left without an outcome gets a second look. Nothing is lost.
// - The LIVE lane answers the user's comments on cards within seconds (alfred-live's Runner, kind "listen"), unless a
//   real /alfred-live runner holds the board; the answers it sees go into the pack for the next judge run.
// Stop: the queue drains, a sweep and a whole-cycle pass find what has no outcome, then three finish runs in parallel
// (the sweep's groups; steps, requirements and what was learned; regressions and shape), then the annotations and the
// session log in code. Each phase is recorded; an interrupted finish resumes with --finish.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const live = await import(pathToFileURL(join(HERE, '..', 'alfred-live', 'alfred-live.mjs')).href).catch(() => {
  throw new Error(`/alfred-live is not installed beside /alfred-listen (${join(HERE, '..', 'alfred-live')}) - reinstall the Alfred skills`);
});
const { Alfred, ClaudePool, LISTEN_TOOLS, LIVE_TOOLS, McpClient, McpHost, Runner, alfredUrlOf, claudeOf, failureKind, failureOf, files, parseArgs, running, serverEntry, summaryOf, tail, writers } = live;
export { McpClient };

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

/** The groups of a check_calls reply as the runner tracks them: from the JSON, with the text block of each. */
export function groupsOf(text, json) {
  const blocks = new Map();
  const lines = String(text).split('\n');
  let current = null;
  for (const line of lines) {
    const m = /^(G\d+) · /.exec(line);
    if (m) { current = m[1]; blocks.set(current, [line]); continue; }
    if (current && (line.startsWith('  ') || line.startsWith('    '))) blocks.get(current).push(line);
    else if (current && line === '') { /* keep going: blank lines inside a block */ }
    else current = null;
  }
  const fromJson = Array.isArray(json?.groups) ? json.groups : [];
  const ids = fromJson.length ? fromJson.map((g) => g.group) : [...blocks.keys()];
  return ids.map((id) => {
    const g = fromJson.find((x) => x.group === id) ?? { group: id };
    const block = blocks.get(id)?.join('\n') ?? '';
    const head = block.split('\n')[0] ?? '';
    return {
      id, key: g.key ?? null, endpoint: g.endpoint ?? (/· \d+ calls? · (\S+ \S+)/.exec(head)?.[1] ?? null),
      callIds: Array.isArray(g.callIds) ? g.callIds : [], exampleCallId: g.exampleCallId ?? (/id=([^\s,)]+)/.exec(block)?.[1] ?? null),
      severity: g.severity ?? 3, signals: Array.isArray(g.signals) ? g.signals : [], calls: g.calls, block,
      shapes: Array.isArray(g.shapes) ? g.shapes : [],
    };
  });
}

/** The identity of a group across batches: check_calls' key, else the endpoint and its signals. */
export function keyOf(group) {
  return group.key ?? (group.endpoint ? `${group.endpoint}|${(group.signals ?? []).join(',')}` : null);
}

/**
 * Whether a recurring "fine" verdict still covers a group: not when the group's calls carry a request shape the verdict
 * was never given on (new code sending a new request - specs/018). A verdict from before shapes were kept covers any.
 */
export function fineCovers(ledger, group) {
  if (!Array.isArray(ledger?.shapes)) return true;
  return (group.shapes ?? []).every((x) => ledger.shapes.includes(x));
}

/** The request shapes a ledger entry keeps: what it had and what the group showed, newest last, at most 20. */
export function shapesAfter(before, group) {
  return [...new Set([...(before ?? []), ...(group.shapes ?? [])])].slice(-20);
}

/** "5 missing · 2 no data · …" from a requirement view's counts, worst first (specs/018). */
export function requirementCounts(view) {
  const order = [['MISSING', 'missing'], ['WRONG', 'wrong'], ['MET', 'met'], ['NO_DATA', 'no data'], ['UNKNOWN', 'unknown'],
    ['NOT_EXERCISED', 'not exercised'], ['MANUAL', 'manual'], ['NO_EVIDENCE', 'no evidence']];
  const c = view?.counts ?? {};
  return order.filter(([k]) => (c[k] ?? 0) > 0).map(([k, w]) => `${c[k]} ${w}`).join(' · ');
}

/** The brief's task branch ("Branch (odeysys): 61813-..."), or null. */
export function briefBranch(brief) {
  const m = /^\s*[-*]?\s*branch\b[^:\n]*:\s*`?([\w./-]{3,})/im.exec(String(brief ?? ''));
  return m ? m[1] : null;
}

/** How many calls of a reply came back with late hop diffs (a number, or a list of ids, depending on the server). */
export function lateWritesOf(json) {
  const v = json?.lateWrites;
  return Array.isArray(v) ? v.length : Number(v ?? 0) || 0;
}

/** Whether a batch needs the model: a flagged group with no known outcome, late hop diffs, or a hung call. */
export function needsRun(json, unknownGroups) {
  return unknownGroups.length > 0 || ((json.totalGroups ?? 0) > 0 && !Array.isArray(json.groups)) || (json.stale?.length ?? 0) > 0;
}

/** A named block a run ends with (LEDGER, UNSURE, CODE, CHECK, STATE): its lines. */
export function blockOf(text, name) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === name);
  if (start < 0) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^(LEDGER|UNSURE|CODE|CHECK|STATE)$/.test(line.trim())) break;
    if (/^```/.test(line.trim())) continue;
    out.push(line);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out;
}

/** The STATE block a run ends with, capped. */
export function stateOf(text) {
  const lines = blockOf(text, 'STATE');
  if (!lines) {
    // the older form, for runs that still write it
    const m = /<<<STATE\s*\n([\s\S]*?)\n\s*STATE>>>/.exec(String(text ?? ''));
    return m ? m[1].trim().slice(0, 2000) : null;
  }
  const s = lines.join('\n').trim();
  return s ? (s.length > 2000 ? `${s.slice(0, 2000)}\n[state cut at 2000 chars]` : s) : null;
}

/** The LEDGER block: group id -> { kind, card, reason, recurs }. */
export function ledgerOf(text) {
  const out = new Map();
  for (const raw of blockOf(text, 'LEDGER') ?? []) {
    const m = /^\s*(G\d+)\s*=\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const [, id, rest] = m;
    const recurs = /\|\s*recurs\s*$/i.test(rest);
    const body = rest.replace(/\|\s*recurs\s*$/i, '').trim();
    let entry;
    if (/^card\s*#?(\d+)/i.test(body)) entry = { kind: 'card', card: Number(/^card\s*#?(\d+)/i.exec(body)[1]) };
    else if (/^link(?:ed)?\s*(?:to\s*)?#?(\d+)/i.test(body)) entry = { kind: 'link', card: Number(/^link(?:ed)?\s*(?:to\s*)?#?(\d+)/i.exec(body)[1]) };
    else if (/^asked\s*#?(\d+)?/i.test(body)) entry = { kind: 'asked', card: Number(/^asked\s*#?(\d+)/i.exec(body)?.[1] ?? 0) || null };
    else if (/^fine\s*:?\s*(.*)$/i.test(body)) entry = { kind: 'fine', reason: /^fine\s*:?\s*(.*)$/i.exec(body)[1].trim() || 'no reason given', recurs };
    else continue;
    out.set(id, entry);
  }
  return out;
}

/** The run's findings for the session: its lines starting "• " (outside the blocks), at most eight. */
export function findingsOf(text) {
  const body = String(text ?? '').split('\n');
  const end = body.findIndex((l) => /^(LEDGER|UNSURE|CODE|CHECK|STATE)$/.test(l.trim()));
  return (end < 0 ? body : body.slice(0, end)).map((l) => l.trim()).filter((l) => l.startsWith('• ')).slice(0, 8);
}

/** How many cards a tool call adds. */
export function cardsAddedBy(tool, input) {
  const name = String(tool).replace(/^mcp__.+?__/, '');
  if (name === 'board_add') return 1;
  if (name === 'board_add_many') return Array.isArray(input?.cards) ? input.cards.length : 0;
  return 0;
}

/** Splits a batch text into the groups named, keeping the parts outside the groups (flows, clean, the JSON line). */
export function cutGroups(text, keep) {
  const lines = String(text).split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const m = /^(G\d+) · /.exec(line);
    if (m) { dropping = !keep.includes(m[1]); if (dropping) continue; }
    else if (dropping && (line.startsWith('  ') || line === '')) continue;
    else dropping = false;
    out.push(line);
  }
  return out.join('\n');
}

/** A batch's groups renumbered from G<from+1>, in its text too, so it can join another batch's run without a clash. */
export function renumberGroups(text, groups, from) {
  const map = new Map(groups.map((g, i) => [g.id, `G${from + i + 1}`]));
  return {
    text: String(text).replace(/\bG\d+\b/g, (m) => map.get(m) ?? m),
    groups: groups.map((g) => ({ ...g, id: map.get(g.id) })),
  };
}

/** Folds a flagged batch into a batch job still waiting its turn: one run judges both. */
export function mergeJob(into, job) {
  const max = Math.max(0, ...(into.groups ?? []).map((g) => Number(String(g.id).slice(1)) || 0));
  const { text: renumbered, groups } = renumberGroups(job.text, job.groups ?? [], max);
  // the joining batch's summary line (JSON, column 0) still names its known groups by their old ids - dropped
  const text = renumbered.split('\n').filter((l) => !/^\{.*\}\s*$/.test(l)).join('\n');
  into.text = `${into.text}\n\n=== batch ${job.batch} (its groups numbered from G${max + 1}) ===\n${text}`;
  into.groups = [...(into.groups ?? []), ...groups];
  into.hung = [...(into.hung ?? []), ...(job.hung ?? [])];
  into.batches = [...(into.batches ?? [into.batch]), job.batch];
  into.what = `${into.what} + ${job.what}`;
  into.live = !!(into.live || job.live);
  return into;
}

/** The base of the task branch for `git diff`: the brief's "base:" line, else the merge base with the usual main branch. */
export function diffStat(cwd, brief = '') {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const named = /\b(?:base|branch from|compare(?:d)? (?:to|with))\s*[:=]\s*([\w./-]+)/i.exec(brief)?.[1];
    let base = null;
    for (const candidate of [named, 'origin/HEAD', 'origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'].filter(Boolean)) {
      try { base = git(['merge-base', 'HEAD', candidate]); if (base) break; } catch { /* next */ }
    }
    if (!base) return null;
    const head = git(['rev-parse', '--short', 'HEAD']);
    if (git(['rev-parse', base]).startsWith(git(['rev-parse', 'HEAD']))) return { base, head, stat: '(no change on this branch yet)' };
    const stat = git(['diff', '--stat=120', `${base}...HEAD`]);
    return { base: git(['rev-parse', '--short', base]), head, stat: stat.slice(0, 10_000) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------------- the runner

export class ListenRunner {
  /**
   * @param o {{ alfred: Alfred, mcp: McpClient, server: string, mcpEntry: object, cycleId: string, project: string,
   *   cwd: string, claude?: string, claudeArgs?: string[], model?: string, dry?: boolean, log: (l: string) => void,
   *   chat?: (l: string) => void, mcpConfigFile: string, stateFile: string, skillDir?: string, waitSec?: number,
   *   settleSec?: number, runTimeoutMs?: number, host?: string, parallel?: number, liveLane?: boolean, pool?: ClaudePool,
   *   warm?: boolean, systemDir?: string }}
   */
  constructor(o) {
    this.o = o;
    this.stopping = false;
    this.now = false;
    this.handles = new Set();
    this.jobsRunning = new Map();
    this.inFlightTitles = new Map(); // job id -> card titles being added
    this.lastSaid = null;
    this.packAt = 0;
    this.pack = {};
    this.lastLimitSaid = 0;
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { [o.server]: o.mcpEntry } }));
    this.s = this.load();
    const rules = this.readSkill('rules.md') ?? '';
    const sys = (name) => {
      const file = join(o.systemDir ?? dirname(o.stateFile), `${randomUUID().slice(0, 8)}-${name}.md`);
      writeFileSync(file, `${rules}\n\n---\n\n${this.readSkill(name) ?? ''}`);
      return file;
    };
    this.systemFiles = { batch: sys('batch.md'), sweep: sys('finish-sweep.md'), steps: sys('finish-steps.md'), regressions: sys('finish-regressions.md'),
      evidence: sys('evidence.md') };
    // The pools are filled once the server's tool list is known (run()), so each run loads only the tools it needs.
    const poolOf = (size, system) => new ClaudePool({ size, warm: false, claude: o.claude, claudeArgs: o.claudeArgs, cwd: o.cwd, server: o.server,
      mcpConfigFile: o.mcpConfigFile, model: o.model, systemPromptFile: system, log: o.log, only: LISTEN_TOOLS, serverTools: this.serverTools,
      tools: ['Read', 'Grep', 'Glob', 'Bash'], allowed: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(codegraph explore:*)'] });
    this.pool = o.pool ?? poolOf(o.parallel ?? 3, this.systemFiles.batch);
    this.poolOf = poolOf;
  }

  readSkill(name) {
    const dir = this.o.skillDir ?? HERE;
    for (const p of [join(dir, name), join(dir, '..', '_shared', name)]) if (existsSync(p)) return readFileSync(p, 'utf8');
    return null;
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
      const s = JSON.parse(readFileSync(this.o.stateFile, 'utf8'));
      return { ...this.fresh(), ...s };
    } catch {
      return this.fresh();
    }
  }

  fresh() {
    return { lastCallId: null, boardCursor: 'now', batch: 0, checked: 0, flagged: 0, groups: 0, cards: 0, linked: 0, runs: 0, narrative: null,
      ledger: {}, queue: [], unsure: [], code: {}, checks: [], userChanges: [], cleanSince: [], hung: [], captureGaps: [], finish: {}, failed: [] };
  }

  save() {
    writeFileSync(this.o.stateFile, JSON.stringify(this.s));
  }

  /** Stop: finish (sweep + review's finish) after the current wait, or at once with now. */
  /** /alfred-live stop reached this runner (specs/020): the live lane stops answering; the calls are still checked. */
  liveOff() {
    if (!this.live || this.live.stopped) return;
    this.live.stop(false);
    this.live.beat(true);
    this.o.log("  ■ live lane stopped (alfred-live stop) - listen keeps checking calls");
    this.o.chat?.("■ /alfred-listen's live lane stopped - listen keeps checking calls");
  }

  stop(now = false) {
    this.stopping = true;
    if (now) {
      this.now = true;
      for (const h of this.handles) h.kill();
      this.live?.stop();
      // the check lane may be inside a check_calls that waits up to a minute for calls: cut it, the loop ends at once
      this.o.mcp.abort?.();
      this.o.alfred.abort?.();
    }
  }

  async status(step, state = 'WATCHING') {
    const r = await this.o.alfred.call('PUT', '/board/agent-status', {
      body: { project: this.o.project, cycleId: this.o.cycleId, state, callsChecked: this.s.checked, cardsAdded: this.s.cards, step: step?.slice(0, 200) },
      timeoutMs: 10_000,
    }).catch(() => null);
    return r?.state === 'PAUSED';
  }

  counts() {
    return `${this.s.checked} calls · ${this.s.flagged} flagged in ${this.s.groups} group${this.s.groups === 1 ? '' : 's'} · ${this.s.cards} card${this.s.cards === 1 ? '' : 's'}`
      + `${this.s.linked ? ` · ${this.s.linked} linked` : ''}`;
  }

  stepLine() {
    const q = this.s.queue.length;
    const req = requirementCounts(this.pack.requirements);
    return `listening to ${this.o.cycleId} · ${this.counts()}${req ? ` · requirements ${req}` : ''}${q ? ` · ${q} batch${q === 1 ? '' : 'es'} being judged` : ''}`;
  }

  // ---------------------------------------------------------------------------------------------- the context pack

  /** What every run needs and the model should never fetch itself: read once, refreshed when the board says it changed. */
  async loadPack(parts = ['task', 'brief', 'acceptance', 'requirements', 'closed', 'teams', 'steps', 'cards', 'diff']) {
    const { mcp, alfred, cycleId, project } = this.o;
    const want = new Set(parts);
    const tasks = [];
    const set = (k, v) => { this.pack[k] = v; };
    const tryCall = (fn, fallback = null) => fn().catch((e) => { this.o.log(`  (pack: ${e.message.slice(0, 160)})`); return fallback; });
    if (want.has('task')) tasks.push(tryCall(() => mcp.call('task_context', { task: cycleId }, 60_000)).then((t) => set('task', t)));
    if (want.has('brief')) tasks.push(tryCall(() => alfred.call('GET', `/board/cycles/${encodeURIComponent(cycleId)}/brief`)).then((b) => {
      const text = String(b?.text ?? '');
      const section = (name) => { const m = new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'im').exec(text); return m ? m[1].trim() : ''; };
      set('brief', { text, outOfScope: section('Out of scope'), decisions: section('Decisions') });
    }));
    if (want.has('acceptance')) tasks.push(tryCall(() => alfred.call('GET', `/board/cycles/${encodeURIComponent(cycleId)}/checklist`), []).then((items) => {
      const list = Array.isArray(items) ? items : (items?.items ?? []);
      set('acceptance', list.map((i, n) => `R${n + 1} | ${i.fileName ?? i.file ?? ''} | ${i.key ?? i.itemKey ?? ''} | ${i.mark?.mark ?? i.mark ?? 'NOT CHECKED'} | ${String(i.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`));
    }));
    if (want.has('closed')) tasks.push(tryCall(() => mcp.call('board_closed_reasons', { project, limit: 200 }, 60_000).catch(() => mcp.call('board_closed_reasons', { project, limit: 60 }, 60_000))).then((t) => set('closed', t)));
    if (want.has('teams') && !this.pack.teams) tasks.push(tryCall(() => mcp.call('board_teams', { project }, 60_000)).then((t) => set('teams', t)));
    if (want.has('steps')) tasks.push(tryCall(() => alfred.call('GET', `/board/cycles/${encodeURIComponent(cycleId)}/steps`), []).then((s) => set('steps', Array.isArray(s) ? s : [])));
    if (want.has('requirements')) tasks.push(this.refreshRequirements());
    if (want.has('cards')) tasks.push(this.refreshCards());
    if (want.has('diff') && !this.pack.diff) tasks.push(Promise.resolve().then(() => set('diff', diffStat(this.o.cwd, this.pack.brief?.text ?? ''))));
    await Promise.all(tasks);
    this.packAt = Date.now();
  }

  /**
   * Where each Acceptance item stands by the calls (specs/018): Alfred judges every call in code and opens the cards; the
   * runner only reads the verdicts - for the pack, the strip and the chat (each change said once).
   */
  async refreshRequirements() {
    const view = await this.o.alfred.call('GET', `/board/cycles/${encodeURIComponent(this.o.cycleId)}/requirements`).catch(() => null);
    if (!view || !Array.isArray(view.items)) return null;
    this.pack.requirements = view;
    this.pack.requirementLines = view.items.map((r, i) => {
      const v = r.verdict ?? {};
      return `AC${i + 1} ${v.verdict ?? '?'}${r.cardNumber ? ` (#${r.cardNumber})` : ''} | ${r.fileName} | ${r.itemKey} | ${String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`
        + `${v.reason ? ` | ${String(v.reason).slice(0, 200)}` : ''}${v.callId ? ` | call ${v.callId}` : ''}`;
    });
    const before = this.s.verdicts ?? {};
    const changes = [];
    const now = {};
    view.items.forEach((r, i) => {
      const v = r.verdict?.verdict;
      now[r.itemKey] = v;
      if (before[r.itemKey] !== v && ['MISSING', 'WRONG', 'MET'].includes(v)) {
        changes.push(`AC${i + 1} ${v}${r.cardNumber ? ` #${r.cardNumber}` : ''}${v !== 'MET' && r.verdict?.reason ? ` - ${String(r.verdict.reason).slice(0, 140)}` : ''}`);
      }
    });
    this.s.verdicts = now;
    if (changes.length && this.packAt) this.say(`  ◆ requirements: ${changes.join(' · ')}`);
    return view;
  }

  /** The cards of this cycle and project, as the board holds them now (open ones first). */
  async refreshCards() {
    const page = await this.o.alfred.call('GET', '/board/cards', { query: { project: this.o.project, cycleId: this.o.cycleId, limit: 500 } }).catch(() => null);
    const cards = page?.cards ?? [];
    this.pack.cards = cards;
    return cards;
  }

  cardLine(c) {
    return `#${c.number} ${c.kind} ${c.status}${c.resolution ? ` (${c.resolution})` : ''} ${c.title}${Array.isArray(c.links) && c.links.length ? ` · calls: ${c.links.filter((l) => l.type === 'call').map((l) => String(l.ref).replace(/^(in|out):/, '').slice(0, 8)).slice(0, 6).join(',')}` : ''}`;
  }

  stepsText() {
    const steps = (this.pack.steps ?? []).map((s) => `[${s.key}] ${s.state === 'SEEN' ? '✓' : s.state === 'FAILED' ? '✗' : '·'} ${s.text}${s.state === 'SEEN' ? ` (${s.calls} calls)` : s.state === 'FAILED' ? ` (card #${s.cardNumber ?? '?'})` : ''}`);
    return [steps.length ? `TEST STEPS (board_mark_step with the [key]):\n${steps.join('\n')}` : 'TEST STEPS: none in the brief',
      'STEPS AND CALLS: a step\'s calls are the calls of the Acceptance items it names (→ AC6) - see REQUIREMENTS - else the ACTIONS line '
        + 'of the batch (check_calls cuts the calls into actions by pause and area, learned from the cycle). Spacers are not used.'].join('\n');
  }

  /** The pack as prompt text: the stable parts first (a cache hit across runs), the per-batch parts after. */
  packText({ groups = [], extra = [] } = {}) {
    const p = this.pack;
    const known = groups.map((g) => {
      const k = keyOf(g);
      const l = k ? this.s.ledger[k] : null;
      if (!l) return null;
      return `${g.id}: seen ${l.seen ?? 1}x before - ${l.kind === 'fine' ? `fine because ${l.reason}` : l.kind === 'asked' ? `asked in #${l.card}` : `${l.kind} #${l.card}`}`;
    }).filter(Boolean);
    const endpoints = new Set(groups.map((g) => g.endpoint).filter(Boolean));
    const code = Object.entries(this.s.code).filter(([e]) => !endpoints.size || endpoints.has(e)).map(([e, n]) => `${e} | ${n}`);
    const unsure = this.s.unsure.map((u) => `${u.flow} | ${u.key} | ${u.change} | ${u.calls} | ${u.action}${u.asked ? ` | asked: yes (#${u.asked})` : ' | asked: no'}`);
    const openCards = (p.cards ?? []).filter((c) => c.status !== 'CLOSED');
    const closedCards = (p.cards ?? []).filter((c) => c.status === 'CLOSED');
    return [
      `CYCLE: ${this.o.cycleId} · project "${this.o.project}" · the Alfred tools are mcp__${this.o.server}__* · the repo is your working folder`,
      this.o.dry ? 'DRY RUN (--dry): write nothing on the board; list what you would write.' : '',
      p.task ? `TASK (task_context):\n${p.task}` : 'TASK: no brief yet',
      p.brief?.outOfScope ? `OUT OF SCOPE (binding):\n${p.brief.outOfScope}` : '',
      p.brief?.decisions ? `DECISIONS (binding):\n${p.brief.decisions}` : '',
      p.acceptance?.length ? `ACCEPTANCE ITEMS (R# | file | FULL key for specItem / board_suggest_mark | mark | text):\n${p.acceptance.join('\n')}` : '',
      p.requirementLines?.length ? `REQUIREMENTS BY THE CALLS (Alfred judges each call in code; a MISSING / WRONG item already has its card - link to it, `
        + `never open a second; "old code" is never a reason for fine):\n${p.requirementLines.join('\n')}` : '',
      p.teams ? `TEAMS:\n${p.teams}` : '',
      this.stepsText(),
      p.closed ? `CLOSED CARDS (never raise a Fine / Not in this flow again):\n${p.closed}` : '',
      p.diff ? `TASK BRANCH DIFF (git diff --stat ${p.diff.base}...${p.diff.head}):\n${p.diff.stat}` : '',
      openCards.length ? `CARDS OF THIS CYCLE ON THE BOARD (link to these, never duplicate):\n${openCards.map((c) => this.cardLine(c)).join('\n')}` : 'CARDS OF THIS CYCLE: none yet',
      closedCards.length ? `CLOSED CARDS OF THIS CYCLE:\n${closedCards.slice(0, 40).map((c) => this.cardLine(c)).join('\n')}` : '',
      [...this.inFlightTitles.values()].flat().length ? `CARDS OTHER RUNS ARE ADDING RIGHT NOW (do not add the same):\n${[...this.inFlightTitles.values()].flat().map((t) => `- ${t}`).join('\n')}` : '',
      code.length ? `CODE NOTES FROM EARLIER RUNS (endpoint | handler | carried values):\n${code.join('\n')}` : '',
      known.length ? `GROUPS SEEN BEFORE:\n${known.join('\n')}` : '',
      unsure.length ? `UNSURE EXPECTATIONS (flow | key | change | calls | action | asked):\n${unsure.join('\n')}` : '',
      this.s.checks.length ? `CHECK LINES TO PROPOSE AT STOP:\n${this.s.checks.join('\n')}` : '',
      this.s.userChanges.length ? `THE USER'S ANSWERS AND NOTES (newest last):\n${this.s.userChanges.slice(-30).join('\n')}` : '',
      this.s.captureGaps.length ? `CAPTURE GAPS (what could not be seen):\n${this.s.captureGaps.join('\n')}` : '',
      this.s.narrative ? `STATE (from the last run):\n${this.s.narrative}` : 'STATE: none yet - the first batch',
      ...extra,
    ].filter(Boolean).join('\n\n');
  }

  // ------------------------------------------------------------------------------------------------------ the loops

  async run() {
    const restartsAtStart = this.o.mcp.restarts;
    this.say(`● Listening to cycle ${this.o.cycleId} (${this.o.project}) on ${this.o.alfred.url} from ${this.o.host ?? hostname()}`
      + ` · no model while calls are clean · ${this.o.parallel ?? 3} runs in parallel${this.o.dry ? ' · dry run: nothing is written' : ''}`);
    await this.loadPack();
    this.serverTools = await this.o.mcp.listTools().catch(() => null);
    await this.branchCheck().catch((e) => this.o.log(`  (branch check: ${e.message.slice(0, 120)})`));
    await this.draftEvidence().catch((e) => this.say(`  ⚠ drafting evidence failed: ${e.message.slice(0, 160)} - listening goes on`));
    if (this.serverTools?.length) this.pool.o.serverTools = this.serverTools;
    if (this.o.warm !== false) { this.pool.size = this.o.parallel ?? 3; this.pool.warmSize = Math.min(this.pool.size, this.o.warmSize ?? 1); this.pool.fill(); }
    if (this.o.liveLane !== false) this.startLiveLane();
    await this.status(this.stepLine());
    this.drainer = this.drainLoop();
    while (!this.stopping) {
      try {
        await this.once();
        if (this.o.mcp.restarts > restartsAtStart && !this.warnedRestart) {
          this.warnedRestart = true;
          this.say('  ⚠ the MCP server restarted - what it had checked is re-checked by the whole-cycle pass at stop');
        }
      } catch (error) {
        if (this.stopping) break;
        if (/not in cycle|sinceCallId/i.test(error.message) && this.s.lastCallId) {
          this.say(`  ⚠ the last checked call is no longer in the cycle - continuing from the start of the cycle (${error.message.slice(0, 120)})`);
          this.s.lastCallId = null;
          this.save();
          continue;
        }
        this.say(`  ⚠ ${error.message} - retrying in 5 s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (this.live) { this.live.stop(this.now); await this.live.idle(); }
    if (!this.now) await this.finish();
    else {
      this.draining = false;
      await this.drainer;
      await this.refreshRequirements().catch(() => null);
      const req = requirementCounts(this.pack.requirements);
      if (!this.o.dry) {
        await this.o.mcp.call('board_session_log', { cycleId: this.o.cycleId, skill: 'alfred-listen',
          did: `Stopped at once (--now), without the finish: ${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs.`,
          found: `${req ? `Requirements by the calls: ${req}.` : 'No requirement verdicts.'}${this.s.narrative ? `\n\n${this.s.narrative}` : ''}`,
          next: `Not done at stop: the sweep, the steps and requirements pass, regressions - /alfred-listen ${this.o.cycleId} --finish runs them.` }, 60_000)
          .catch((e) => this.o.log(`  (session log: ${e.message.slice(0, 120)})`));
      }
      await this.status(`stopped without the finish${req ? ` · requirements ${req}` : ''} - /alfred-listen ${this.o.cycleId} --finish runs it`, 'STOPPED');
      this.say(`● Listen stopped without the finish${req ? ` - requirements: ${req}` : ''} · session log written - \`/alfred-listen ${this.o.cycleId} --finish\` runs the rest.`);
    }
    this.pool.close();
    this.o.mcp.close();
  }

  /** The live lane: alfred-live's runner for this project, answering the user's comments on cards within seconds. */
  startLiveLane() {
    const o = this.o;
    this.live = new Runner({ alfred: o.alfred, server: o.server, mcpEntry: o.mcpEntry, project: o.project, cycleId: o.cycleId, model: o.model,
      cwd: o.cwd, claude: o.claude, claudeArgs: o.claudeArgs, log: o.log, chat: o.chat, mcpConfigFile: o.mcpConfigFile, mcp: o.mcp,
      pool: this.poolOf(1, undefined), parallel: 2, kind: 'listen', host: o.host, waitSeconds: 50, settleMs: 1000, serverTools: this.serverTools,
      chatId: o.chatId, chatPid: o.chatPid });
    this.live.pool.o.only = LIVE_TOOLS;
    if (this.o.warm !== false) { this.live.pool.size = 1; this.live.pool.warmSize = 1; this.live.pool.fill(); }
    this.live.run().catch((e) => this.say(`  ⚠ live lane ended: ${e.message}`));
  }

  /** check_calls, every page of one batch; returns the whole text, the first page's summary and the groups of every page. */
  async checkAll(args) {
    const base = { cycle: this.o.cycleId, listener: `listen:${this.o.cycleId}`, maxDiffs: 200 };
    const first = await this.o.mcp.call('check_calls', { ...base, ...args }, ((args.waitSec ?? 0) + 120) * 1000);
    const json = batchOf(first);
    const texts = [first];
    const groups = groupsOf(first, json);
    let next = json.next;
    let guard = 0;
    while (next != null && guard++ < 50) {
      const page = await this.o.mcp.call('check_calls', { ...base, ...(args.sinceCallId ? { sinceCallId: args.sinceCallId } : {}),
        ...(args.sweep ? { sweep: true } : {}), offset: next, ...(json.lastCallId ? { untilCallId: json.lastCallId } : {}) });
      const pj = batchOf(page);
      texts.push(page);
      groups.push(...groupsOf(page, pj));
      next = pj.next;
    }
    if ((json.totalGroups ?? 0) > groups.length) this.o.log(`  ⚠ paging gave ${groups.length} of ${json.totalGroups} groups`);
    return { text: texts.join('\n\n'), json, groups, texts };
  }

  /** One batch: wait (no model), check, then note it, handle it in code, or queue it for a judge run. */
  async once() {
    if (!this.s.lastCallId) {
      // Nothing checked yet: the first batch is every call already in the cycle - or the first ones to come.
      const r = await this.checkAll({ boardCursor: this.s.boardCursor });
      if (!r.json.lastCallId && !(r.json.totalGroups ?? 0)) {
        if (r.json.board?.cursor) this.s.boardCursor = r.json.board.cursor;
        this.noteBoard(r.json);
        await this.o.mcp.call('wait_for_calls', { cycleId: this.o.cycleId, timeoutSec: this.o.waitSec ?? 60, settleSec: this.o.settleSec ?? 3 }, 180_000);
        return;
      }
      return this.handle(r);
    }
    const r = await this.checkAll({ sinceCallId: this.s.lastCallId, waitSec: this.o.waitSec ?? 60, settleSec: this.o.settleSec ?? 3, boardCursor: this.s.boardCursor });
    if (this.stopping && this.now) return;
    const j = r.json;
    if (!j.checked && !(j.totalGroups ?? 0) && !lateWritesOf(j) && !(j.stale?.length ?? 0) && !(j.board?.changes?.length) && !(j.board?.cycleChanges?.length)) {
      if (j.board?.cursor) this.s.boardCursor = j.board.cursor;
      if (j.pending?.length && !this.saidPending) { this.saidPending = true; this.o.log(`  (waiting: ${j.pending.length} call(s) still running)`); }
      return; // nothing arrived: wait again
    }
    this.saidPending = false;
    return this.handle(r);
  }

  /** The board part of a check_calls reply: the user's changes go to the pack (the live lane answers them); brief / spec / mark edits refresh it. */
  noteBoard(json) {
    const changes = json.board?.changes ?? [];
    for (const u of changes) {
      const line = String(u).slice(0, 400);
      this.o.log(`  ${line}`);
      this.s.userChanges = [...this.s.userChanges, line].slice(-50);
    }
    const cycleChanges = json.board?.cycleChanges ?? [];
    if (cycleChanges.length) {
      for (const c of cycleChanges) this.o.log(`  ${String(c).slice(0, 300)}`);
      const what = cycleChanges.join(' ');
      const parts = ['cards'];
      if (/brief/i.test(what)) parts.push('task', 'brief', 'steps');
      if (/spec|mark|checklist|acceptance/i.test(what)) parts.push('acceptance', 'task');
      this.loadPack(parts).catch(() => {});
    }
    if (changes.some((u) => /closed|moved|resolution/i.test(String(u)))) this.loadPack(['closed', 'cards']).catch(() => {});
  }

  async handle({ text, json, groups, texts }) {
    this.s.batch++;
    this.s.checked += json.checked ?? 0;
    this.s.flagged += json.flaggedCalls ?? 0;
    this.s.groups += json.totalGroups ?? 0;
    if (json.lastCallId) this.s.lastCallId = json.lastCallId;
    if (json.board?.cursor) this.s.boardCursor = json.board.cursor;
    if (Array.isArray(json.captureGaps) && json.captureGaps.length) {
      for (const g of json.captureGaps) if (!this.s.captureGaps.includes(g)) { this.s.captureGaps.push(g); this.say(`  ⚠ capture: ${g}`); }
    }
    const n = this.s.batch;
    this.noteBoard(json);
    const hung = Array.isArray(json.stale) ? json.stale.filter((h) => !this.s.hung.includes(h.callId)) : [];
    for (const h of hung) { this.s.hung.push(h.callId); this.say(`  ⚠ call never completed: ${h.endpoint ?? h.callId} (running ${Math.round((h.ageSec ?? 0) / 60)} min)`); }

    // Groups the ledger knows: a card still open is linked in code, a recurring fine verdict is counted; the rest run.
    await this.refreshCards().catch(() => {});
    const { known, unknown } = await this.splitKnown(groups);
    const what = [`batch ${n} · ${json.checked ?? 0} calls`,
      json.totalGroups ? `${json.flaggedCalls} flagged in ${json.totalGroups} group${json.totalGroups === 1 ? '' : 's'}` : 'all clean',
      json.rechecked ? `rechecked ${json.rechecked} (late logs / SQL)` : null,
      lateWritesOf(json) ? `${lateWritesOf(json)} with late hop diffs` : null,
      known.length ? `${known.length} known (${known.map((k) => `${k.group.id}→${k.ledger.kind === 'fine' ? 'fine' : `#${k.ledger.card}`}`).join(', ')})` : null,
      (json.board?.changes?.length) ? `${json.board.changes.length} change${json.board.changes.length === 1 ? '' : 's'} of yours (live lane)` : null,
    ].filter(Boolean).join(' · ');

    if ((json.checked ?? 0) > 0) await this.refreshRequirements().catch(() => null);
    const paused = await this.status(this.stepLine());
    if (!needsRun(json, unknown) && !hung.length) {
      const clean = cleanLine(text);
      if (clean || known.length) this.s.cleanSince = [...this.s.cleanSince, `batch ${n}: ${clean ?? ''}${known.length ? ` · known groups: ${known.map((k) => `${k.group.id} ${k.group.endpoint ?? ''} → ${k.ledger.kind === 'fine' ? 'fine' : `#${k.ledger.card}`}`).join('; ')}` : ''}`].slice(-200);
      this.o.log(`${what}      (no run)`);
      // An all-green stretch still ticks its steps: one small run every 8 clean batches.
      if (this.s.cleanSince.length >= 8 && !this.s.queue.some((j) => j.kind === 'steps') && (this.pack.steps ?? []).length) this.enqueue({ kind: 'steps', batch: n, text: '' });
      this.save();
      return;
    }
    const keep = unknown.map((g) => g.id);
    const jobText = keep.length && keep.length < groups.length ? cutGroups(text, keep) : text;
    const job = { kind: 'batch', batch: n, text: jobText, groups: unknown.map(({ block, ...g }) => g), what, hung, live: !!json.board?.live };
    this.o.log(`${what}${paused ? ' · ⏸ paused on the board - judged when you resume' : ''}`);
    if (paused) this.say('  ⚠ ⏸ paused on the board - flagged batches are held and judged when you resume');
    // A big batch is several runs (at most 8 groups each), judged in parallel.
    if (unknown.length > 10) {
      for (let i = 0; i < unknown.length; i += 8) {
        const part = unknown.slice(i, i + 8);
        this.enqueue({ ...job, text: cutGroups(text, part.map((g) => g.id)), groups: part.map(({ block, ...g }) => g), part: `${i / 8 + 1}/${Math.ceil(unknown.length / 8)}` });
      }
    } else {
      this.enqueueBatch(job);
    }
    this.save();
  }

  /**
   * A flagged batch: folded into a batch job still waiting its turn (one run for several small batches), else queued
   * after a short gather - longer while another batch is being judged, so the batches arriving meanwhile join it.
   */
  enqueueBatch(job) {
    const open = this.s.queue.find((j) => j.kind === 'batch' && !j.part && !j.tries && !this.jobsRunning.has(j.id)
      && (j.groups?.length ?? 0) + (job.groups?.length ?? 0) <= (this.o.mergeMax ?? 10));
    if (open) {
      mergeJob(open, job);
      this.o.log(`  + batch ${job.batch} joins the run of batch ${open.batches.join(', ')} (${open.groups.length} groups)`);
      return;
    }
    const busy = this.s.queue.some((j) => j.kind === 'batch' && this.jobsRunning.has(j.id));
    this.enqueue({ ...job, nextAt: Date.now() + (busy ? (this.o.holdMs ?? 10_000) : (this.o.gatherMs ?? 2_000)) });
  }

  /** Groups whose key the ledger knows with an outcome that still holds - linked / counted in code - and the rest. */
  async splitKnown(groups) {
    const known = [];
    const unknown = [];
    const open = new Map((this.pack.cards ?? []).map((c) => [c.number, c]));
    for (const g of groups) {
      const k = keyOf(g);
      const l = k ? this.s.ledger[k] : null;
      let handled = false;
      if (l && !this.o.dry) {
        if ((l.kind === 'card' || l.kind === 'link') && l.card && ['INBOX', 'TO_DO', 'IN_PROGRESS'].includes(open.get(l.card)?.status)) {
          handled = await this.linkRecurrence(g, l).catch((e) => { this.o.log(`  (link failed: ${e.message.slice(0, 120)})`); return false; });
        } else if (l.kind === 'fine' && l.recurs) {
          handled = fineCovers(l, g);
          if (!handled) this.o.log(`  ${g.id} ${g.endpoint ?? ''}: fine before, but its calls send a new request shape - judged again`);
          else if (!Array.isArray(l.shapes) && (g.shapes ?? []).length) l.shapes = shapesAfter([], g);
        }
      }
      if (handled) { l.seen = (l.seen ?? 1) + 1; known.push({ group: g, ledger: l }); } else unknown.push(g);
    }
    return { known, unknown };
  }

  /** A recurrence of a carded problem: its first, last and worst call linked to the card (at most 3), a note on the first recurrence. */
  async linkRecurrence(g, l) {
    const ids = [...new Set([g.exampleCallId, g.callIds?.[0], g.callIds?.at?.(-1)].filter(Boolean))].slice(0, 3);
    if (!ids.length) return false;
    const links = ids.map((id) => ({ type: 'call', ref: `in:${id}@${this.o.cycleId}`, label: `${g.endpoint ?? 'call'} (seen again)` }));
    await this.o.mcp.call('board_link', { project: this.o.project, number: l.card, links }, 30_000);
    this.s.linked += ids.length;
    if (!l.seen || l.seen === 1) {
      await this.o.mcp.call('board_comment', { project: this.o.project, number: l.card, did: `Seen again while listening (batch ${this.s.batch}): ${g.endpoint ?? ''} - ${g.calls ?? ids.length} call(s) linked.`,
        found: 'The same problem recurs; no new card.', next: 'Linked every recurrence; the re-test plan on this card says when it is fixed.' }, 30_000).catch(() => {});
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------- judge jobs

  enqueue(job) {
    this.s.queue.push({ id: randomUUID().slice(0, 8), tries: 0, nextAt: 0, ...job });
    this.save();
  }

  /** Runs queued jobs, up to `parallel` at once, retrying failures; runs until stop (then until the queue is empty). */
  async drainLoop() {
    this.draining = true;
    const limit = this.o.parallel ?? 3;
    while (this.draining || this.jobsRunning.size) {
      if (this.draining) {
        const now = Date.now();
        for (const job of this.s.queue) {
          if (this.jobsRunning.size >= limit) break;
          if (this.jobsRunning.has(job.id) || job.nextAt > now) continue;
          this.jobsRunning.set(job.id, this.runJob(job).catch((e) => this.say(`  ⚠ job ${job.id}: ${e.message}`)).finally(() => this.jobsRunning.delete(job.id)));
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Runs every queued job now and waits for them (the tests, and --finish's catch-up); the drain loop does this in the background. */
  async judgeQueued() {
    for (let guard = 0; guard < 10 && this.s.queue.length; guard++) {
      const jobs = this.s.queue.filter((j) => !this.jobsRunning.has(j.id));
      if (!jobs.length) { await new Promise((r) => setTimeout(r, 200)); continue; }
      await Promise.all(jobs.map((job) => { const p = this.runJob(job).finally(() => this.jobsRunning.delete(job.id)); this.jobsRunning.set(job.id, p); return p; }));
    }
  }

  /** Waits until the queue is empty and nothing runs (stop) - unless stopped at once. */
  async drained() {
    while (!this.now && (this.s.queue.length || this.jobsRunning.size)) {
      const ready = this.s.queue.some((j) => j.nextAt <= Date.now());
      if (!ready && !this.jobsRunning.size) {
        // only jobs waiting out a usage limit: run them now, once, so the stop does not wait for the limit
        for (const j of this.s.queue) j.nextAt = 0;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  promptOf(job) {
    if (job.kind === 'steps') {
      return this.packText({ extra: [`CLEAN BATCHES SINCE THE LAST RUN:\n${this.s.cleanSince.join('\n')}`,
        'THIS RUN: only board_mark_step the steps the clean batches above showed (SEEN with the call count). Judge nothing else. End with the → line and an empty LEDGER.'] });
    }
    if (job.kind === 'second-look') {
      return this.packText({ groups: job.groups, extra: [job.evidence ?? '', `THE GROUPS THE LAST RUN LEFT WITHOUT AN OUTCOME (batch ${job.batch}) - give each one its outcome now:\n${job.text}`] });
    }
    const hung = job.hung?.length ? `NEVER COMPLETED (judge each: a BUG or fine with why):\n${job.hung.map((h) => `- ${h.endpoint ?? ''} call ${h.callId} started ${h.startedAt ?? ''}, running ${Math.round((h.ageSec ?? 0) / 60)} min`).join('\n')}` : '';
    return this.packText({ groups: job.groups, extra: [
      this.s.cleanSince.length ? `CLEAN BATCHES SINCE THE LAST RUN (mark their steps too):\n${this.s.cleanSince.join('\n')}` : '',
      job.board ?? '',
      job.evidence ?? '',
      hung,
      `THE BATCH (check_calls output${job.part ? `, part ${job.part}` : ', every page'}):\n${job.text}`,
    ] });
  }

  /** investigate_call on each group's example call, run in code so the judge starts with the evidence it reads first. */
  async evidenceFor(groups) {
    if (this.o.evidence === false) return '';
    const picked = groups.filter((g) => g.exampleCallId).slice(0, this.o.evidenceGroups ?? 10);
    if (!picked.length) return '';
    const per = this.o.evidenceChars ?? 6000;
    const parts = await Promise.all(picked.map((g) => this.o.mcp.call('investigate_call', { callId: g.exampleCallId, cycleId: this.o.cycleId }, 30_000)
      .then((t) => `${g.id} evidence - ${g.endpoint ?? ''} call ${g.exampleCallId}:\n${t.length > per ? `${t.slice(0, per)}\n[cut here - investigate_call for the rest]` : t}`)
      .catch(() => null)));
    const ok = parts.filter(Boolean);
    return ok.length ? `EVIDENCE - investigate_call already ran on each group's example call (do not run it again on these calls; drill further only where this is not enough):\n${ok.join('\n\n')}` : '';
  }

  /** What the board already holds about each group's calls - looked up in code so the run links instead of adding twice. */
  async boardFor(groups) {
    const lines = [];
    const ids = [...new Set(groups.flatMap((g) => [g.exampleCallId, ...(g.callIds ?? []).slice(0, 5)]).filter(Boolean))];
    if (!ids.length) return '';
    const badges = await this.o.alfred.call('GET', '/board/call-badges', { query: { callIds: ids.slice(0, 100).join(',') } }).catch(() => null);
    if (!badges) return '';
    for (const g of groups) {
      const mine = [g.exampleCallId, ...(g.callIds ?? [])].filter(Boolean);
      const cards = new Map();
      for (const id of mine) for (const b of (Array.isArray(badges[id]) ? badges[id] : badges[id]?.cards ?? [])) cards.set(b.number ?? b.cardNumber, b);
      if (cards.size) lines.push(`${g.id}: ${[...cards.values()].map((b) => `#${b.number ?? b.cardNumber} ${b.kind ?? ''} ${b.status ?? ''} ${b.title ?? ''}`.trim()).join('; ')}`);
    }
    return lines.length ? `ALREADY ON THE BOARD (board_link to these, no new card):\n${lines.join('\n')}` : '';
  }

  /** One judge job: a fresh run, its blocks merged into the state, its ledger checked against the groups, retried on failure. */
  async runJob(job) {
    const started = Date.now();
    const batches = job.batches?.length > 1 ? `es ${job.batches.join(', ')}` : ` ${job.batch}`;
    const head = job.kind === 'steps' ? 'marking steps' : job.kind === 'second-look' ? `second look at batch ${job.batch}` : `judging batch${batches}${job.part ? ` (${job.part})` : ''}`;
    this.o.log(`  ✦ ${head}…`);
    // What the run would read first - the board's cards for its calls, each group's investigation - fetched in code, in parallel.
    const judged = job.kind === 'batch' || job.kind === 'second-look';
    [job.board, job.evidence] = await Promise.all([
      job.kind === 'batch' ? this.boardFor(job.groups ?? []).catch(() => '') : '',
      judged ? this.evidenceFor(job.groups ?? []).catch(() => '') : '',
    ]);
    const prompt = this.promptOf(job);
    const p = this.pool.acquire();
    const titles = [];
    let refused = [];
    let lastStatus = 0;
    const handle = this.pool.run(p, prompt, {
      timeoutMs: this.o.runTimeoutMs ?? 20 * 60_000, inactivityMs: 4 * 60_000,
      onStep: async (step, steps, draft, tool, input) => {
        if (!step) return false;
        if (/board_add_many$/.test(tool ?? '')) titles.push(...(input?.cards ?? []).map((c) => c.title).filter(Boolean));
        if (/board_add$/.test(tool ?? '') && input?.title) titles.push(input.title);
        this.inFlightTitles.set(job.id, titles);
        this.o.log(`    · ${step}`);
        if (Date.now() - lastStatus > 1500) { lastStatus = Date.now(); this.status(`${head} · ${step}`).catch(() => {}); }
        return this.now;
      },
      onToolResult: (_id, isError, text, name) => {
        if (/board_add(_many)?$/.test(name)) {
          const added = [...String(text).matchAll(/added #(\d+)/g)].length;
          this.s.cards += added;
          if (isError || /not added|refused/i.test(text)) refused.push(String(text).slice(0, 200));
        }
      },
    });
    this.handles.add(handle);
    const { result, stderr, stopAsked } = await handle.done;
    this.handles.delete(handle);
    this.inFlightTitles.delete(job.id);
    this.s.runs++;
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    if (stopAsked || this.now) {
      this.o.log(`  ■ ${head} stopped after ${secs} s`);
      this.save();
      return;
    }
    if (!result || result.error) return this.failed(job, failureOf(result, stderr), head);
    this.merge(result.text, job);
    const summary = (summaryOf(result.text) ?? '→ judged').replace(/^→\s*/, '');
    this.o.log(`  → ✦ Claude (${secs} s): ${summary}`);
    for (const r of refused) this.o.log(`    (board: ${r})`);
    this.o.chat?.(`${job.what ?? head} → ${summary}`);
    const findings = findingsOf(result.text);
    for (const f of findings) this.say(`  ${f}`);
    // specs/022 FR-030: what listen found also shows in the cycle's board chat, marked as the listen runner's; a clean batch posts nothing.
    if (findings.length) {
      this.o.alfred.call('POST', `/board/chats/${encodeURIComponent(this.o.cycleId)}/system`, { headers: { 'X-Alfred-Actor': 'claude' },
        query: { project: this.o.project ?? '' }, body: { text: `👂 listen runner: ${summary}\n${findings.map((f) => `- ${f}`).join('\n')}`.slice(0, 8000) } })
        .catch(() => {});
    }
    this.s.queue = this.s.queue.filter((j) => j.id !== job.id);
    if (job.kind === 'batch' || job.kind === 'second-look') this.s.cleanSince = [];
    if (job.kind === 'steps') this.s.cleanSince = [];
    // Every group accounted for? The ones the run left without an outcome get one more look.
    if (job.kind === 'batch') await this.coverage(job, result.text);
    this.save();
    await this.status(this.stepLine());
  }

  /** The groups of a batch the run's LEDGER did not account for: one second look; after that, the finish gets them. */
  async coverage(job, text) {
    const ledger = ledgerOf(text);
    const cards = new Set((await this.refreshCards().catch(() => this.pack.cards ?? [])).map((c) => c.number));
    const missing = (job.groups ?? []).filter((g) => {
      const l = ledger.get(g.id);
      if (!l) return true;
      if ((l.kind === 'card' || l.kind === 'link') && l.card && cards.size && !cards.has(l.card)) return true;
      return false;
    });
    if (!missing.length) return;
    const ids = missing.map((g) => g.id);
    if (job.kind === 'second-look' || job.secondLook) {
      this.say(`  ⚠ batch ${job.batch}: ${ids.join(', ')} still without an outcome - judged at stop`);
      this.s.failed.push({ batch: job.batch, groups: missing, text: cutGroups(job.text, ids) });
      return;
    }
    this.o.log(`  ⚠ batch ${job.batch}: ${ids.join(', ')} without an outcome - a second look`);
    this.enqueue({ kind: 'second-look', batch: job.batch, text: cutGroups(job.text, ids), groups: missing, what: `batch ${job.batch} · second look`, secondLook: true });
  }

  /** The blocks a run ends with, merged into the runner's state: ledger by group key, unsure, code notes, check lines, narrative. */
  merge(text, job) {
    const ledger = ledgerOf(text);
    for (const g of job.groups ?? []) {
      const entry = ledger.get(g.id);
      const k = keyOf(g);
      if (!entry || !k) continue;
      this.s.ledger[k] = { ...entry, seen: this.s.ledger[k]?.seen ?? 1, batch: job.batch, endpoint: g.endpoint ?? null,
        shapes: shapesAfter(this.s.ledger[k]?.shapes, g) };
    }
    for (const raw of blockOf(text, 'UNSURE') ?? []) {
      const parts = raw.split('|').map((x) => x.trim());
      if (parts.length < 4 || !parts[0]) continue;
      const [flow, key, change, calls, action = 'ask', asked = ''] = parts;
      const existing = this.s.unsure.find((u) => u.flow === flow && u.key === key);
      const askedNo = /asked:\s*yes\s*\(?#?(\d+)/i.exec(asked)?.[1] ?? null;
      if (existing) { existing.change = change; existing.calls = calls; existing.action = action; if (askedNo) existing.asked = Number(askedNo); }
      else this.s.unsure.push({ flow, key, change, calls, action, asked: askedNo ? Number(askedNo) : null });
    }
    for (const raw of blockOf(text, 'CODE') ?? []) {
      const [endpoint, ...rest] = raw.split('|').map((x) => x.trim());
      if (endpoint && rest.length) this.s.code[endpoint] = rest.join(' | ').slice(0, 400);
    }
    for (const raw of blockOf(text, 'CHECK') ?? []) {
      const line = raw.trim();
      if (line && !this.s.checks.includes(line)) this.s.checks.push(line);
    }
    const narrative = stateOf(text);
    if (narrative) this.s.narrative = narrative;
    else if (job.kind === 'batch') this.o.log('  (the run wrote no STATE block - the last one is kept)');
  }

  /** A failed run: the job stays queued and is tried again - at once for a split prompt, later for a limit. */
  async failed(job, why, head) {
    const kind = failureKind(why);
    job.tries++;
    job.lastFailure = why;
    if (kind === 'too-long' && (job.groups?.length ?? 0) > 1) {
      const half = Math.ceil(job.groups.length / 2);
      const parts = [job.groups.slice(0, half), job.groups.slice(half)];
      this.s.queue = this.s.queue.filter((j) => j.id !== job.id);
      for (const part of parts) this.enqueue({ ...job, id: undefined, tries: 0, text: cutGroups(job.text, part.map((g) => g.id)), groups: part, part: `${job.part ?? ''}½`.trim() });
      this.o.log(`  ⚠ ${head}: the prompt was too long - split in two`);
    } else if (kind === 'auth') {
      job.nextAt = Date.now() + 30 * 60_000;
      this.say(`  ⚠ ${head} failed: ${why} - Claude is not logged in; the batch waits (log in, the runner tries again in 30 min)`);
    } else if (kind === 'limit') {
      job.nextAt = Date.now() + 10 * 60_000;
      if (Date.now() - this.lastLimitSaid > 10 * 60_000) { this.lastLimitSaid = Date.now(); this.say(`  ⚠ usage limit - ${this.s.queue.length} batch${this.s.queue.length === 1 ? '' : 'es'} queued, judged when it lifts (${why})`); }
    } else {
      const delays = [20_000, 60_000, 180_000, 300_000];
      job.nextAt = Date.now() + delays[Math.min(job.tries - 1, delays.length - 1)];
      this.o.log(`  ⚠ ${head} failed: ${why} - again in ${Math.round((job.nextAt - Date.now()) / 1000)} s`);
      if (job.tries === 2) this.say(`  ⚠ ${head} failed twice: ${why} - still queued`);
    }
    this.save();
  }

  // -------------------------------------------------------------------------------------------------------- start

  /** Items with no evidence yet get it drafted by one run before the first batch, so the calls are judged from the start. */
  async draftEvidence() {
    const view = this.pack.requirements;
    const missing = (view?.items ?? []).map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => r.verdict?.verdict === 'NO_EVIDENCE');
    if (!missing.length || this.o.dry || this.s.finish.evidence) return;
    this.say(`  ◆ ${missing.length} Acceptance item${missing.length === 1 ? ' has' : 's have'} no evidence - drafting it before the first batch`);
    await this.phase('evidence', 'drafting evidence', this.systemFiles.evidence, async () => this.packText({ extra: [
      `ITEMS WITHOUT EVIDENCE (AC# | file | key | text):\n${missing.map(({ r, n }) => `AC${n} | ${r.fileName} | ${r.itemKey} | ${r.text}`).join('\n')}`,
    ] }), () => {}, 'starting');
    await this.refreshRequirements();
    await this.status(this.stepLine());
  }

  /** The task branch has no commit since its base: one TASK at start (once per cycle), and a strip warning. */
  async branchCheck() {
    if (this.s.noChangeCard || this.o.dry) return;
    const diff = this.pack.diff;
    if (!diff || !/no change on this branch yet/.test(diff.stat ?? '')) return;
    const named = briefBranch(this.pack.brief?.text);
    let current = null;
    try { current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.o.cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no git */ }
    if (!named || !current || named !== current) return; // another branch is checked out: this repo says nothing about the task
    const base = String(diff.base ?? '').slice(0, 10);
    const title = `Task branch has no changes since ${base}`;
    if ((this.pack.cards ?? []).some((c) => c.title === title)) { this.s.noChangeCard = true; return; }
    await this.o.mcp.call('board_add', { project: this.o.project, kind: 'TASK', cycleId: this.o.cycleId, teams: [], title,
      description: `**The task branch \`${current}\` has no commit since its base ${base}, so the calls test the old code.**\n\n`
        + `> found by the listen runner (git, no model)\n\n### Next\nBuild the task on the branch and deploy it, then use the page again.` }, 60_000)
      .then(() => { this.s.cards++; })
      .catch((e) => this.o.log(`  (no-change card: ${e.message.slice(0, 120)})`));
    this.s.noChangeCard = true;
    this.save();
    this.say(`  ⚠ the task branch ${current} has no commit since ${base} - the calls test the old code`);
  }

  // ------------------------------------------------------------------------------------------------------- finish

  /** Stop: settle, drain, sweep + a whole-cycle pass for what has no outcome, three finish runs in parallel, then code. */
  async finish() {
    const f = this.s.finish;
    this.say('■ Stop · finishing: the queue, the sweep, then steps, regressions and the session log…');
    await this.status(`finishing ${this.o.cycleId} · judging what is left`);
    // The last burst settles before the sweep (log lines and SQL arrive a few seconds after a call).
    if (!f.settled && this.s.lastCallId) {
      for (let i = 0; i < 3; i++) {
        const r = await this.checkAll({ sinceCallId: this.s.lastCallId, waitSec: 8, settleSec: 2, boardCursor: this.s.boardCursor }).catch(() => null);
        if (!r) break;
        if (r.json.checked || r.json.totalGroups || lateWritesOf(r.json)) await this.handle(r);
        if (!(r.json.recheckPending ?? 0)) break;
      }
      f.settled = true;
      this.save();
    }
    await this.drained();
    this.draining = false;
    await this.drainer;
    await this.loadPack(['cards', 'closed', 'steps', 'acceptance', 'requirements', 'task']);

    // Part 1: the sweep plus a whole-cycle pass - the groups with no outcome anywhere.
    if (!f.sweep) {
      await this.status(`finishing ${this.o.cycleId} · sweep`);
      let leftover = this.s.failed.map((x) => ({ text: x.text, groups: x.groups }));
      try {
        const sweep = await this.checkAll({ sweep: true });
        this.s.checked += sweep.json.checked ?? 0;
        const { unknown } = await this.splitKnown(sweep.groups);
        if (unknown.length) leftover.push({ text: cutGroups(sweep.text, unknown.map((g) => g.id)), groups: unknown.map(({ block, ...g }) => g) });
        this.o.log(`  sweep · ${sweep.json.checked ?? 0} calls never checked or changed since · ${sweep.groups.length} group(s), ${unknown.length} without an outcome`);
      } catch (error) {
        this.say(`  ⚠ sweep failed: ${error.message}`);
      }
      try {
        // Review's own pass: every flagged group of the cycle, in a fresh memory; only the ones no card and no ledger entry cover.
        const whole = await this.checkAll({ listener: `finish:${this.o.cycleId}:${randomUUID().slice(0, 6)}` });
        const badges = await this.o.alfred.call('GET', `/board/cycles/${encodeURIComponent(this.o.cycleId)}/call-badges`).catch(() => ({}));
        const covered = (g) => {
          const k = keyOf(g);
          if (k && this.s.ledger[k]) return true;
          return [g.exampleCallId, ...(g.callIds ?? [])].filter(Boolean).some((id) => (Array.isArray(badges[id]) ? badges[id].length : (badges[id]?.cards?.length ?? 0)) > 0);
        };
        const open = whole.groups.filter((g) => !covered(g));
        if (open.length) leftover.push({ text: cutGroups(whole.text, open.map((g) => g.id)), groups: open.map(({ block, ...g }) => g) });
        this.o.log(`  whole-cycle pass · ${whole.groups.length} group(s), ${open.length} with no card, link or verdict`);
      } catch (error) {
        this.say(`  ⚠ whole-cycle pass failed: ${error.message}`);
      }
      f.sweepJobs = leftover.map((l, i) => ({ kind: 'batch', batch: `stop-${i + 1}`, text: l.text, groups: l.groups, what: `stop · ${l.groups.length} group(s) without an outcome`, finish: true }));
      f.sweep = true;
      this.save();
    }

    // Parts 1-3 in parallel: each its own run, retried once, recorded.
    const phases = [];
    if (!f.p1) phases.push(this.phase('p1', 'the sweep', this.systemFiles.sweep, async () => {
      const jobs = f.sweepJobs ?? [];
      if (!jobs.length) return 'nothing left without an outcome';
      const text = jobs.map((j) => `## ${j.what}\n${j.text}`).join('\n\n');
      const groups = jobs.flatMap((j) => j.groups);
      return this.packText({ groups, extra: [await this.boardFor(groups).catch(() => ''), `THE GROUPS WITHOUT AN OUTCOME:\n${text}`] });
    }, (text) => { for (const j of f.sweepJobs ?? []) this.merge(text, j); }));
    if (!f.p2) phases.push(this.phase('p2', 'steps and requirements', this.systemFiles.steps, async () => this.packText({ extra: [
      `CLEAN BATCHES NOT YET MARKED:\n${this.s.cleanSince.join('\n') || '(none)'}`,
      `COUNTS: ${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs`,
    ] }), (text) => this.merge(text, { kind: 'finish' })));
    if (!f.p3) phases.push(this.phase('p3', 'regressions and shape', this.systemFiles.regressions, async () => {
      const [cycles, regressions] = await Promise.all([
        this.o.mcp.call('list_cycles', {}, 60_000).catch((e) => `(list_cycles failed: ${e.message})`),
        this.o.mcp.call('board_regressions', { project: this.o.project }, 60_000).catch((e) => `(board_regressions failed: ${e.message})`),
      ]);
      let compared = '';
      try {
        const list = JSON.parse(String(cycles).split('\n').find((l) => l.startsWith('{')) ?? '{}')?.cycles ?? [];
        const mine = list.find((c) => c.id === this.o.cycleId);
        const words = new Set(String(mine?.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
        const previous = list.filter((c) => c.id !== this.o.cycleId && c.createdAt < (mine?.createdAt ?? 'z'))
          .map((c) => ({ c, score: String(c.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length }))
          .sort((a, b) => b.score - a.score || (b.c.createdAt > a.c.createdAt ? 1 : -1))[0]?.c;
        if (previous) compared = `COMPARED WITH THE MOST SIMILAR EARLIER CYCLE "${previous.name}" (${previous.id}):\n${await this.o.mcp.call('compare_cycles', { before: previous.id, after: this.o.cycleId }, 120_000).catch((e) => `(compare_cycles failed: ${e.message})`)}`;
        else compared = 'COMPARED: no earlier cycle found - skip regressions and say so';
      } catch { compared = 'COMPARED: the cycle list could not be read'; }
      return this.packText({ extra: [`EARLIER CYCLES (list_cycles):\n${String(cycles).slice(0, 6000)}`, `BOARD REGRESSIONS (board_regressions):\n${String(regressions).slice(0, 8000)}`, compared] });
    }, (text) => this.merge(text, { kind: 'finish' })));
    await Promise.all(phases);

    // Part 4, in code: the calls behind this listen's cards get a note; the session log; the strip.
    if (!f.p4 && f.p1 && f.p2 && f.p3) {
      try {
        const cards = (await this.refreshCards().catch(() => this.pack.cards ?? [])).filter((c) => c.status !== 'CLOSED');
        const comments = [];
        for (const c of cards) for (const l of (c.links ?? []).filter((l) => l.type === 'call').slice(0, 3)) {
          const m = /^(in|out):([^@]+)/.exec(String(l.ref));
          if (m) comments.push({ callId: m[2], direction: m[1] === 'in' ? 'inbound' : 'outbound', comment: `See card #${c.number} (${c.kind}): ${c.title}` });
        }
        if (comments.length && !this.o.dry) await this.o.mcp.call('add_comments', { comments: comments.slice(0, 200) }, 120_000).catch((e) => this.o.log(`  (annotations: ${e.message.slice(0, 120)})`));
        const steps = this.pack.steps ?? [];
        const seen = steps.filter((s) => s.state === 'SEEN').length;
        const failedSteps = steps.filter((s) => s.state === 'FAILED').length;
        const untested = steps.length - seen - failedSteps;
        if (!this.o.dry) await this.o.mcp.call('board_session_log', { cycleId: this.o.cycleId, skill: 'alfred-listen',
          did: `${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs · ${this.s.failed.length ? `${this.s.failed.length} group set(s) needed the stop pass` : 'every group judged as it came'}`,
          found: `${cards.length} open card(s) of this cycle; steps: ${seen} seen, ${failedSteps} failed, ${untested} untested; ${this.s.unsure.filter((u) => !u.asked).length} unsure expectation(s) still unasked`
            + `${this.s.checks.length ? `\n\nAlfred checks to save (before/after for the user):\n${this.s.checks.join('\n')}` : ''}${this.s.captureGaps.length ? `\n\nCapture gaps: ${this.s.captureGaps.join('; ')}` : ''}`,
          next: 'Sort the Inbox (/alfred-triage); the unasked expectations and check lines wait for the user.' }, 60_000).catch((e) => this.o.log(`  (session log: ${e.message.slice(0, 120)})`));
        f.p4 = true;
      } catch (error) {
        this.say(`  ⚠ finish part 4 failed: ${error.message}`);
      }
      this.save();
    }
    const ok = f.p1 && f.p2 && f.p3 && f.p4;
    this.finishedOk = !!ok;
    await this.status(ok ? `stopped · ${this.counts()}` : `finish incomplete (${['p1', 'p2', 'p3', 'p4'].filter((k) => !f[k]).join(', ')}) - /alfred-listen ${this.o.cycleId} --finish`, 'STOPPED');
    if (ok) this.say(`● Listen stopped · ${this.counts()} · ${this.s.batch} batches · ${this.s.runs} runs`);
    else this.say(`⚠ Finish incomplete (${['p1', 'p2', 'p3', 'p4'].filter((k) => !f[k]).join(', ')}) - \`/alfred-listen ${this.o.cycleId} --finish\` resumes it`);
  }

  /** One finish phase: a run on a transient process with its own system prompt, retried once, recorded in the state. */
  async phase(key, name, systemFile, buildPrompt, onText, verb = 'finishing') {
    const f = this.s.finish;
    for (let attempt = 0; attempt < 2 && !this.now; attempt++) {
      const started = Date.now();
      this.o.log(`  ✦ ${verb}: ${name}…`);
      const prompt = await buildPrompt();
      if (typeof prompt === 'string' && /^nothing left/.test(prompt)) { f[key] = true; this.o.log(`  finish: ${name} - ${prompt}`); this.save(); return; }
      const pool = this.poolOf(0, systemFile);
      const p = pool.acquire();
      let lastStatus = 0;
      const handle = pool.run(p, prompt, { timeoutMs: 15 * 60_000, inactivityMs: 4 * 60_000,
        onStep: async (step, steps, draft, tool, input) => {
          if (!step) return false;
          this.o.log(`    · ${step}`);
          if (Date.now() - lastStatus > 1500) { lastStatus = Date.now(); this.status(`${verb} · ${name} · ${step}`).catch(() => {}); }
          return this.now;
        },
        onToolResult: (_id, isError, text, tool) => { if (/board_add(_many)?$/.test(tool)) this.s.cards += [...String(text).matchAll(/added #(\d+)/g)].length; },
      });
      this.handles.add(handle);
      const { result, stderr } = await handle.done;
      this.handles.delete(handle);
      pool.close();
      this.s.runs++;
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      if (result && !result.error) {
        onText(result.text);
        f[key] = true;
        const summary = (summaryOf(result.text) ?? '→ done').replace(/^→\s*/, '');
        this.o.log(`  → ✦ ${name} (${secs} s): ${summary}`);
        this.o.chat?.(`${verb === 'finishing' ? 'stop' : 'start'} · ${name} → ${summary}`);
        for (const x of findingsOf(result.text)) this.say(`  ${x}`);
        this.save();
        return;
      }
      const why = failureOf(result, stderr);
      this.say(`  ⚠ ${verb}: ${name} failed: ${why}${attempt === 0 ? ' - once more' : ''}`);
      if (failureKind(why) === 'limit' || failureKind(why) === 'auth') break;
    }
    this.save();
  }
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
    let state = null;
    try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); state = { batches: s.batch, checked: s.checked, cards: s.cards, queued: s.queue?.length ?? 0, runs: s.runs, finish: s.finish }; } catch { /* none */ }
    print({ running: !!r, ...(r ?? {}), alfred: url, log: f.log, ...(state ? { state } : {}), last: tail(f.log, Number(args.lines ?? 20)) });
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
    // The chat that runs this owns the cycle: ▶ on the cycle's cards goes into it. One chat per cycle - another one is refused.
    const chatId = args.chat ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    const chatPid = args['chat-pid'] ?? process.env.CLAUDE_PID ?? null;
    if (chatId && args['no-live'] !== 'true') {
      await alfred.call('PUT', '/board/live-runner', { body: { project: args.project, host: hostname(), stopped: false, kind: 'listen',
        cycleId: args.cycle, chatId, cwd, chatAlive: true } }).catch((error) => {
        if (/→ 409/.test(error.message)) throw new Error(error.message.replace(/^.*?→ 409: /, ''));
      });
    }
    if (existsSync(stopFile)) unlinkSync(stopFile);
    if (args.fresh === 'true' && existsSync(stateFile)) unlinkSync(stateFile);
    appendFileSync(f.log, '');
    appendFileSync(f.chat, '');
    const self = fileURLToPath(import.meta.url);
    const chatArgs = chatId ? ['--chat', chatId, ...(chatPid ? ['--chat-pid', String(chatPid)] : [])] : [];
    const child = spawn(process.execPath, [self, 'run', ...argv.slice(1), '--cwd', cwd, '--url', url, ...chatArgs], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    const started = { pid: child.pid, alfred: url, cycleId: args.cycle, project: args.project, chatId, model: args.model ?? null, parallel: Number(args.parallel ?? 3),
      dry: args.dry === 'true', finishOnly: args.finish === 'true', log: f.log, chat: f.chat, startedAt: new Date().toISOString() };
    writeFileSync(f.pid, JSON.stringify(started));
    print({ started: true, ...started, model: args.model ?? "Claude Code's default", watch: `tail -n 0 -F "${f.chat}"` });
    return;
  }
  if (command === 'run') {
    const { log, chat } = writers(f);
    process.on('uncaughtException', (error) => log(`  ⚠ ${error.stack ?? error.message}`));
    process.on('unhandledRejection', (error) => log(`  ⚠ ${error?.stack ?? error}`));
    const host = new McpHost(entry, { cwd, log });
    const mcpEntry = await host.start();
    const mcp = new McpClient(mcpEntry, { cwd, name: 'alfred-listen' });
    const runner = new ListenRunner({ alfred: new Alfred(url), mcp, server: args.server, mcpEntry, cycleId: args.cycle, project: args.project,
      cwd, ...claudeOf(args), model: args.model, dry: args.dry === 'true', log, chat, mcpConfigFile: f.mcp, stateFile, parallel: Number(args.parallel ?? 3),
      waitSec: args.wait ? Number(args.wait) : undefined, settleSec: args.settle ? Number(args.settle) : undefined, liveLane: args['no-live'] !== 'true',
      chatId: args.chat, chatPid: args['chat-pid'] });
    host.onRestart = (u) => { mcp.entry = { type: 'http', url: u }; mcp.session = null; writeFileSync(f.mcp, JSON.stringify({ mcpServers: { [args.server]: { type: 'http', url: u } } })); };
    const onStop = () => {
      if (!existsSync(stopFile)) return;
      const how = readFileSync(stopFile, 'utf8').trim();
      unlinkSync(stopFile);
      log(`  ■ stop file read: ${how}`);
      if (how === 'live-off') { runner.liveOff(); return; }
      runner.stop(how === 'now');
    };
    const signal = (name) => { log(`  ■ ${name} received - stopping now`); runner.stop(true); };
    process.on('SIGTERM', () => signal('SIGTERM'));
    process.on('SIGINT', () => signal('SIGINT'));
    process.on('SIGHUP', () => signal('SIGHUP'));
    process.on('exit', (code) => { if (!runner.stopping) log(`  ■ process exit ${code} without a stop`); });
    const watch = setInterval(onStop, 2000);
    if (args.finish === 'true') runner.stop(false);
    try {
      await runner.run();
    } finally {
      clearInterval(watch);
      host.close();
      if (existsSync(f.pid)) unlinkSync(f.pid);
      if (runner.finishedOk && existsSync(stateFile)) unlinkSync(stateFile); // finished: the next listen starts fresh
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
