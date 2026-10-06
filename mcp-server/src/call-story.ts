import { seg, type AlfredClient } from './alfred-client.ts';
import { loadCapture } from './db-capture.ts';
import type { CallLogsPage, CapturedStatement, LinkedLogLine } from './frontend.ts';
import { maskText, type MaskContext } from './masking.ts';
import { WHY } from './signals.ts';

/**
 * One call's story (specs/010-mcp-log-investigation, US4): its database statements, supplier calls and caught log lines
 * in the call's own order - the agent's sequence number they share - the order the database window's Together view
 * shows. Built from the per-call endpoints that already exist; nothing new on the backend.
 */

/** A call's lines are read whole (the backend's per-call cap is 5,000), then filtered and paged by the tools. */
export const MAX_LINES = 5000;
const LONG = 300;

export interface StoryItem {
  readonly kind: 'statement' | 'supplier' | 'log';
  readonly seq: number;
  /** From the call's start. */
  readonly offsetMs: number | null;
  /** One compact line - SQL, supplier call or log message (masked, long parts shortened with their full length). */
  readonly text: string;
  readonly error?: true;
  /** log: its line id (for log_context and exception_source); statement: its id (for db_statement). */
  readonly ref?: string | number;
  readonly level?: string | null;
  readonly logger?: string | null;
  readonly exception?: { readonly type: string | null; readonly message: string | null };
}

export interface CallLines {
  readonly first: CallLogsPage | null;
  readonly lines: LinkedLogLine[];
  /** Why there are none, when there are none. */
  readonly why: string | null;
}

/** Every caught line of a call (paged through /call-logs), and why there are none when there are none. */
export async function callLines(client: AlfredClient, callId: string, cycleId?: string): Promise<CallLines> {
  const lines: LinkedLogLine[] = [];
  let first: CallLogsPage | null = null;
  let after: string | null = null;
  do {
    const page: CallLogsPage = await client.get<CallLogsPage>(`/call-logs/${seg(callId)}`, {
      query: { cycleId, after: after ?? undefined, limit: 500 },
      notFound: `Call ${callId} not found (an inbound call id; pass cycleId for a call only a session cycle still holds).`,
    });
    first ??= page;
    lines.push(...page.lines);
    after = page.lines.length ? page.next : null;
  } while (after && lines.length < MAX_LINES);
  return { first, lines, why: lines.length ? null : whyNoLines(first) };
}

export function whyNoLines(page: CallLogsPage | null): string {
  if (!page) return WHY.LOGS_OFF;
  if (page.setup === 'LINKING_OFF') return WHY.LOGS_OFF;
  if (page.setup === 'NO_AGENT') return WHY.NO_AGENT;
  const level = page.logLevel ? `${page.logLevel}${page.levelAssumed ? ' (assumed - the project\'s current setting)' : ''}` : 'ERROR';
  return `no lines at ${level === 'APP' ? "the application's own level" : `${level} or above`} were written during this call - ${WHY.BELOW_LEVEL}`;
}

function shorten(ctx: MaskContext, value: string | null | undefined): string {
  const v = maskText(ctx, (value ?? '').replace(/\s+/g, ' ').trim());
  return v.length > LONG ? `${v.slice(0, LONG)}… (${v.length} chars)` : v;
}

const ERROR_LEVELS = new Set(['ERROR', 'SEVERE', 'FATAL']);

export function isErrorLine(line: LinkedLogLine): boolean {
  return ERROR_LEVELS.has((line.level ?? '').toUpperCase()) || !!line.exception;
}

function statementItem(ctx: MaskContext, s: CapturedStatement): StoryItem {
  const failed = s.outcome.kind === 'FAILED';
  const what = failed
    ? ` ✖ failed ${s.outcome.sqlState ?? ''} ${shorten(ctx, s.outcome.message)}${s.outcome.swallowed ? ' · swallowed' : ''}`
    : s.outcome.rowsRead != null ? ` → ${s.outcome.rowsRead} rows` : s.outcome.affected != null ? ` → ${s.outcome.affected} affected` : '';
  return {
    kind: 'statement', seq: s.seq, offsetMs: Math.round(s.offsetMicros / 1000), ref: s.id,
    text: `${s.kind} ${shorten(ctx, s.sql)} (${(s.durationMicros / 1000).toFixed(1)} ms)${what}`, ...(failed ? { error: true as const } : {}),
  };
}

function logItem(ctx: MaskContext, l: LinkedLogLine): StoryItem {
  return {
    kind: 'log', seq: l.seq ?? 0, offsetMs: l.offsetMs ?? null, ref: l.lineId, level: l.level, logger: l.logger ?? null,
    text: `${l.level ?? 'LOG'} ${l.logger ? `${l.logger.slice(l.logger.lastIndexOf('.') + 1)}: ` : ''}${shorten(ctx, l.message)}`,
    ...(l.exception ? { exception: { type: l.exception.type ?? null, message: l.exception.message ? shorten(ctx, l.exception.message) : null } } : {}),
    ...(isErrorLine(l) ? { error: true as const } : {}),
  };
}

const RANK: Record<StoryItem['kind'], number> = { statement: 0, supplier: 1, log: 2 };

export interface CallStory {
  readonly items: StoryItem[];
  readonly firstErrorIndex: number | null;
  readonly statementsWhy: string | null;
  readonly linesWhy: string | null;
  readonly linesTotal: number;
}

/** The whole story of a call, in its own order. */
export async function callStory(client: AlfredClient, ctx: MaskContext, callId: string, cycleId?: string): Promise<CallStory> {
  const [capture, logs] = await Promise.all([
    loadCapture(client, callId).catch(() => null),
    callLines(client, callId, cycleId).catch(() => ({ first: null, lines: [], why: WHY.LOGS_OFF }) as CallLines),
  ]);
  const items: StoryItem[] = [];
  for (const s of capture?.statements ?? []) items.push(statementItem(ctx, s));
  for (const m of capture?.supplierMarkers ?? []) {
    items.push({ kind: 'supplier', seq: m.seq, offsetMs: null, text: `→ supplier call ${m.method ?? ''} ${maskText(ctx, m.url ?? '')}`.trim() });
  }
  for (const l of logs.lines) items.push(logItem(ctx, l));
  items.sort((a, b) => a.seq - b.seq || RANK[a.kind] - RANK[b.kind]);
  const firstError = items.findIndex((i) => i.error);
  return {
    items, firstErrorIndex: firstError >= 0 ? firstError : null,
    statementsWhy: capture ? null : 'this call has no database capture (◆ was off for its project, or the agent was not attached when it ran)',
    linesWhy: logs.why, linesTotal: logs.lines.length,
  };
}
