import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AlfredClient } from './alfred-client.ts';
import { maskContext } from './masking.ts';
import type { ChangeRow, ChangesPage } from './tools/board.ts';
import { beat, byCard, cardContext } from './tools/live.ts';

/**
 * The /alfred-live runner (docs/mcp.md "Live answers"): a plain process that waits on Alfred's board for the user's
 * next change - no model runs while it waits - and answers each card with ONE fresh `claude -p` run, so no context
 * ever grows. Every step of that run (its tool calls, read from --output-format stream-json) and the reply as it is
 * written are reported to Alfred (PUT /board/live-work), which shows them on the card and the live strip while they
 * happen. One line per event goes to the log the user's session watches. The user's Stop on the card ends the run.
 */

export interface RunnerOptions {
  readonly client: AlfredClient;
  readonly project?: string;
  readonly cycleId?: string;
  readonly model?: string;
  /** The app's repo: the run reads its code from here. */
  readonly cwd: string;
  /** The Claude Code command; tests pass a stand-in. */
  readonly claude: string;
  /** Extra arguments before ours (tests: the stand-in script). */
  readonly claudeArgs?: readonly string[];
  /** MCP config file giving the run the Alfred tools as server "alfred". */
  readonly mcpConfig: string;
  readonly log: (line: string) => void;
  readonly settleMs?: number;
  readonly waitSeconds?: number;
  readonly runTimeoutMs?: number;
  /** How often the draft is reported while it is being written. */
  readonly draftEveryMs?: number;
}

/** What the user did, as the head of the live box: "acting on your answer". */
export function headOf(changes: readonly ChangeRow[], parentIsQuestion: (e: ChangeRow) => boolean): { head: string; quiet: boolean } {
  const kinds = changes.map((e) => e.kind);
  if (changes.some((e) => e.kind === 'COMMENT' && e.replyTo != null && parentIsQuestion(e))) return { head: 'acting on your answer', quiet: false };
  if (changes.some((e) => e.kind === 'COMMENT' && e.replyTo != null)) return { head: 'working on your reply', quiet: false };
  const comment = changes.find((e) => e.kind === 'COMMENT');
  if (comment) {
    return { head: /\?\s*$|@claude/i.test(comment.text ?? '') ? 'working on your question' : 'working on your comment', quiet: false };
  }
  if (changes.some((e) => e.kind === 'STATUS' && e.newValue === 'FIXED')) return { head: 'preparing the re-test', quiet: false };
  if (kinds.some((k) => k === 'PROPOSAL_DISMISSED' || k === 'REOPENED')) return { head: 'reading why', quiet: false };
  if (kinds.some((k) => k === 'DESCRIPTION' || k === 'TITLE' || k === 'KIND')) return { head: 'reading your edit', quiet: false };
  return { head: 'noting your change', quiet: true };
}

/** "You moved it In progress → Fixed", for the log and the quiet note. */
export function youDid(e: ChangeRow): string {
  const text = (e.text ?? '').replace(/\s+/g, ' ').trim();
  const short = text.length > 160 ? `${text.slice(0, 160)}…` : text;
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
    default: return `You: ${e.kind.toLowerCase()}`;
  }
}

function pretty(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** One tool call of the run as the step the user reads: "checking call 3f2a…", "reading OrderMapper.java:58". */
export function stepLabel(tool: string, input: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const s = (k: string) => (typeof input[k] === 'string' || typeof input[k] === 'number' ? String(input[k]) : '');
  const card = s('number') ? `#${s('number')}` : 'the card';
  const id = (v: string) => (v.length > 12 ? `${v.slice(0, 8)}…` : v);
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
    case 'board_assign': return `→ assigning ${card} to ${Array.isArray(input['teams']) ? (input['teams'] as string[]).join(', ') : 'teams'}`;
    case 'board_retest_plan': return `→ setting ${card}'s re-test plan`;
    case 'board_move': return `→ moving ${card} to ${pretty(s('status'))}`;
    case 'Read': return `reading ${basename(s('file_path'))}${s('offset') ? `:${s('offset')}` : ''}`;
    case 'Grep': return `searching the code for "${s('pattern')}"`;
    case 'Glob': return `finding files ${s('pattern')}`;
    default: return name.replace(/_/g, ' ');
  }
}

/** The text a reply tool is being given, from its partial JSON - shown as the reply types in. */
export function draftOf(partialJson: string): string | null {
  const m = /"(?:text|question|did)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (!m) return null;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16))
    : c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

const RULES = `You are Alfred live: you answer the user on the Alfred task board while they work, one change of theirs at a time.
- Answer in the card's thread with board_reply (replyTo = the [index] of the user's comment, or of your question they answered). 1-3 short sentences, plain words, in the user's language. Say what you did, never what you are about to think.
- An answer to your question: reply with what it changes ("Got it - ..."), then do it within the board's limits (board_edit your own Inbox card's kind/description, board_add a BUG with the calls, board_flag, board_assign). A question back only when it is still unclear (board_ask, once).
- A question to you: look it up first (at most three Alfred or code lookups), then answer with the evidence as mentions (@[call:in:<id>|label]).
- A move to Fixed with no re-test plan: board_retest_plan. A dismissed proposal: one board_comment (did/found/next) with what you will do instead. An edit: answer only if it changes your work.
- Never move cards to To do for the user, never close, mark the checklist or set scope - propose (board_propose, board_suggest_mark).
- The repo is your working folder: read the code there when the answer needs it. Change no file.
- End with one line: "→ " and what you did (e.g. "→ replied; turned #12 into a BUG").`;

/** The prompt of one run: the rules, the card as board_live gives it, and what to do. */
export function promptFor(project: string, card: Record<string, unknown>): string {
  return `${RULES}\n\nProject: ${project || '(No project)'} - the Alfred tools are mcp__alfred__*.\n\nTHE CARD AND WHAT THE USER JUST DID:\n`
    + `${JSON.stringify(card, null, 1)}\n\nAnswer this change now.`;
}

interface StreamLine {
  type: string;
  subtype?: string;
  event?: { type: string; index?: number; content_block?: { type: string; name?: string; input?: unknown }; delta?: { type: string; partial_json?: string; text?: string } };
  message?: { content?: { type: string; name?: string; input?: Record<string, unknown>; text?: string }[] };
  result?: string;
  is_error?: boolean;
}

export class LiveRunner {
  private stopped = false;
  private current: ChildProcess | null = null;
  private wakeWait: (() => void) | null = null;

  constructor(private readonly o: RunnerOptions) {}

  stop(): void {
    this.stopped = true;
    this.current?.kill();
    this.wakeWait?.();
    beat(this.o.client.baseUrl, this.o.project ?? null, true);
  }

  /** Waits and answers until stop(). */
  async run(): Promise<void> {
    let cursor = 'now';
    this.o.log(`● Live on for ${this.o.project || 'every board'}${this.o.cycleId ? ` (cycle ${this.o.cycleId})` : ''} - answering on the board; each event shows here.`);
    while (!this.stopped) {
      beat(this.o.client.baseUrl, this.o.project ?? null);
      try {
        cursor = await this.once(cursor);
      } catch (error) {
        if (this.stopped) break;
        this.o.log(`  ⚠ ${(error as Error).message} - retrying in 5 s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    this.o.log('● Live stopped.');
  }

  /** One wait and the answers it brings; returns the next cursor. */
  async once(cursor: string): Promise<string> {
    const { client } = this.o;
    const query = { project: this.o.project, cycleId: this.o.cycleId, actor: 'USER' };
    const waitSeconds = this.o.waitSeconds ?? 50;
    let page = await client.get<ChangesPage>('/board/changes/wait', {
      query: { ...query, cursor, timeoutSeconds: waitSeconds }, timeoutMs: (waitSeconds + 10) * 1000,
    });
    if (this.stopped || (!page.entries.length && !page.cycles.length)) return page.cursor;
    await new Promise((r) => setTimeout(r, this.o.settleMs ?? 1200));
    page = await client.get<ChangesPage>('/board/changes', { query: { ...query, cursor, limit: 200 } }).catch(() => page);
    if (this.o.project !== undefined) {
      const status = await client.get<{ state: string } | null>('/board/agent-status', { query: { project: this.o.project } }).catch(() => null);
      if (status?.state === 'PAUSED') {
        this.o.log(`  ⏸ paused on the board - ${page.entries.length} change(s) not answered`);
        return page.cursor;
      }
    }
    const ctx = await maskContext(client, undefined);
    for (const changes of byCard(page.entries).values()) {
      if (this.stopped) break;
      await this.answer(changes, await cardContext(client, ctx, changes).catch(() => null));
    }
    return page.cursor;
  }

  private async answer(changes: ChangeRow[], card: Record<string, unknown> | null): Promise<void> {
    const first = changes[0];
    const label = `#${first.number}`;
    for (const e of changes) this.o.log(`${label} "${first.title}"  ${youDid(e)}`);
    const userDid = (card?.['userDid'] as string[] | undefined) ?? [];
    const { head, quiet } = headOf(changes, (e) => userDid.some((d, i) => changes[i] === e && d.startsWith('ANSWERS')));
    const id = randomUUID();
    const started = Date.now();
    const report = async (body: Record<string, unknown>) => this.o.client.put<{ stop?: boolean }>('/board/live-work', {
      headers: { 'X-Alfred-Actor': 'claude' },
      body: { id, project: first.project, cardNumber: first.number, head, ...body },
    }).catch(() => ({ stop: false }));

    if (!card) {
      await report({ steps: [], state: 'FAILED', outcome: 'could not read the card' });
      this.o.log(`  ⚠ ${label} failed: could not read the card`);
      return;
    }
    if (quiet) {
      const note = `Noted - ${changes.map(youDid).join('; ').replace(/^You /, 'you ')}.`;
      await report({ steps: changes.map(youDid), state: 'DONE', outcome: note });
      this.o.log(`  → ✦ ${note}`);
      return;
    }

    const steps: string[] = [];
    let draft: string | null = null;
    let lastDraftAt = 0;
    let stopAsked = false;
    await report({ steps, state: 'WORKING' });
    this.o.log(`  ✦ ${head} on ${label}…`);

    // The prompt goes on stdin: a card's context can pass Windows' command-line limit.
    const args = [...(this.o.claudeArgs ?? []), '-p', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--mcp-config', this.o.mcpConfig, '--strict-mcp-config',
      '--allowedTools', 'mcp__alfred', 'Read', 'Grep', 'Glob', ...(this.o.model ? ['--model', this.o.model] : [])];
    const child = spawn(this.o.claude, args, { cwd: this.o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.current = child;
    child.stdin?.end(promptFor(first.project, card));
    const timeout = setTimeout(() => child.kill(), this.o.runTimeoutMs ?? 5 * 60_000);
    let result: { text: string; error: boolean } | null = null;
    let partial = '';
    let partialTool: string | null = null;
    let buffer = '';
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });

    const onStep = async (s: string) => {
      steps.push(s);
      this.o.log(`    · ${s}`);
      const r = await report({ steps, draft, state: 'WORKING' });
      if (r.stop && !stopAsked) { stopAsked = true; child.kill(); }
    };
    const onLine = async (line: string) => {
      let msg: StreamLine;
      try { msg = JSON.parse(line) as StreamLine; } catch { return; }
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          partialTool = ev.content_block.name ?? null;
          partial = '';
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && partialTool && /board_(reply|ask|comment)$/.test(partialTool)) {
          partial += ev.delta.partial_json ?? '';
          const d = draftOf(partial);
          if (d && Date.now() - lastDraftAt > (this.o.draftEveryMs ?? 400)) {
            draft = d;
            lastDraftAt = Date.now();
            const r = await report({ steps, draft, state: 'WORKING' });
            if (r.stop && !stopAsked) { stopAsked = true; child.kill(); }
          }
        }
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'tool_use' && c.name) {
            if (/board_(reply|ask|comment)$/.test(c.name)) draft = draftOf(JSON.stringify(c.input ?? {})) ?? draft;
            await onStep(stepLabel(c.name, c.input ?? {}));
          }
        }
      } else if (msg.type === 'result') {
        result = { text: msg.result ?? '', error: !!msg.is_error };
      }
    };
    let chain = Promise.resolve();
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) chain = chain.then(() => onLine(line));
    });
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    if (buffer.trim()) chain = chain.then(() => onLine(buffer));
    await chain;
    clearTimeout(timeout);
    this.current = null;

    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const res = result as { text: string; error: boolean } | null;
    const summary = (res?.text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('→')).at(-1) ?? null;
    if (stopAsked || this.stopped) {
      await report({ steps, draft, state: 'STOPPED', outcome: 'stopped by you' });
      this.o.log(`  ■ ${label} stopped after ${secs} s`);
    } else if (!res || res.error) {
      const why = res?.text?.trim() || stderr.trim().split('\n').at(-1) || 'the run ended without a result';
      await report({ steps, draft, state: 'FAILED', outcome: why.slice(0, 300) });
      this.o.log(`  ⚠ ${label} failed: ${why.slice(0, 300)}`);
    } else {
      await report({ steps, draft, state: 'DONE', outcome: summary ?? 'answered' });
      this.o.log(`  → ✦ Claude (${secs} s): ${draft ?? summary ?? 'answered on the card'}`);
      if (summary && draft) this.o.log(`    ${summary}`);
    }
  }
}

/** Where a runner for this Alfred and project keeps its log and its pid. */
export function liveFiles(baseUrl: string, project: string | undefined): { log: string; pid: string; mcp: string } {
  const key = `${baseUrl}|${project ?? ''}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80);
  const dir = tmpdir();
  return { log: join(dir, `alfred-live-${key}.log`), pid: join(dir, `alfred-live-${key}.pid.json`), mcp: join(dir, `alfred-live-${key}.mcp.json`) };
}

/** Writes one log line with a time - the user's session tails this file. */
export function fileLogger(path: string): (line: string) => void {
  writeFileSync(path, '', { flag: 'a' });
  return (line) => {
    const t = new Date().toTimeString().slice(0, 8);
    appendFileSync(path, line.split('\n').map((l) => `${t} ${l}`).join('\n') + '\n');
  };
}
