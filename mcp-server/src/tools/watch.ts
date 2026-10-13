import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { toRow } from '../calls.ts';
import { cycleEntries, requireCycle, type CycleEntry } from '../cycle-calls.ts';
import type { CallRecord, TriageEntry } from '../frontend.ts';
import { maskCalls, maskContext, maskMeta } from '../masking.ts';
import { ok, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';
import { signalsOfEntry, type SignalName } from '../signals.ts';
import { triageOf } from '../triage.ts';

/** Alfred's own "something changed" sockets: a captured call arrives on the calls sockets, cycle edits on session-cycles. */
const SOCKETS = ['/ws/calls', '/ws/internal-calls', '/ws/session-cycles'];
/** Waiting for a kind of trouble: a call's log lines and statements (and so its marks) settle a moment after it ends. */
const SIGNAL_SOCKETS = ['/ws/db-capture', '/ws/triage'];

/** A call still running this long after it started is hung, not busy: nothing waits for it any more. */
export const STALE_MS = 300_000;

export function finished(call: CallRecord): boolean {
  return call.state !== 'IN_PROGRESS';
}

/**
 * A call a batch must wait for: still running, and not for so long that it has surely hung. `now` is Alfred's clock
 * (client.now()), the one the call's timestamp is in. A hung call is passed over - the calls behind it are checked, and
 * it is reported once as never completed.
 */
export function blocking(call: CallRecord, now: number): boolean {
  return !finished(call) && now - Date.parse(call.timestamp) < STALE_MS;
}

/** What to wait for (specs/010): any new call, or the next one that logged an error / a warning, had a failed statement, or any problem. */
export type Until = 'any' | 'logError' | 'logWarning' | 'dbFailed' | 'problem';

function matches(until: Until, signals: SignalName[]): boolean {
  switch (until) {
    case 'logError': return signals.includes('LOG_ERROR') || signals.includes('LOG_EXCEPTION');
    case 'logWarning': return signals.includes('LOG_WARNING');
    case 'dbFailed': return signals.includes('DB_FAILED');
    case 'problem': return signals.length > 0;
    default: return true;
  }
}
const SETTLE_MS = 400;
const MAX_WAIT_S = 60;
/** With a pause to wait for, a burst that never pauses is returned this long after its first call. */
const BURST_MAX_MS = 20_000;
/** A failing call ends the wait after this grace (the rest of its burst, its supplier calls, are on their way). */
const EARLY_GRACE_MS = 1_000;
/** A socket that closed or failed leaves its signals unheard: look this often instead. */
const FALLBACK_MS = 5_000;

/**
 * Waits until a cycle holds calls it did not hold before - so an agent can add spacers while the
 * user is still clicking, not only after "stop". Not a poll: it listens on the same WebSocket
 * signals the UI reloads on, re-reads the cycle only when one fires, and gives up after a bounded
 * wait (60 s at most), so a tool call can never hang.
 */
/** Something besides new calls that ends a wait - e.g. the late log lines of a call checked too early, or the user's comment on the board. */
export interface Wake {
  readonly sockets: readonly string[];
  readonly changed: () => Promise<boolean>;
  /** Something that turns true by the clock, not by a signal: ask `changed` once this long after the wait began. */
  readonly afterMs?: number;
  /** Said in the reply: why the wait ended. */
  readonly label?: string;
}

export interface WaitOptions {
  /** Calls running right now: one of them finishing is a fresh call even if it sits before sinceCallId. */
  readonly watch?: ReadonlySet<string>;
  /** With a pause to wait for: a fresh finished call with an error or this status or over ends the wait after a short grace. */
  readonly minStatus?: number;
  /** Tests: shorter than the 20 s a burst may last, and than the 5 s between looks when a socket is gone. */
  readonly burstMs?: number;
  readonly fallbackMs?: number;
}

export interface Waited {
  readonly newEntries: CycleEntry[];
  readonly total: number;
  readonly timedOut: boolean;
  readonly recording: boolean;
  readonly matched: CycleEntry[];
  /** The label of the wake that ended the wait, if one did. */
  readonly woke?: string;
}

/**
 * A message on a call socket that cannot change what a wait is waiting for: a websocket call's frames, the live log
 * cleared, a call that was only prepared (it is running - its end is the signal), or a call another cycle captured.
 */
function isNoise(data: unknown, cycleId: string, waitingForPause: boolean): boolean {
  let message: { type?: unknown; call?: { state?: unknown } | null; capturedByCycleIds?: unknown } | null;
  try {
    message = JSON.parse(String(data));
  } catch {
    return false;
  }
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'ws-messages-appended' || message.type === 'calls-cleared') return true;
  if (message.call && typeof message.call === 'object') {
    if (waitingForPause && message.call.state === 'IN_PROGRESS') return true;
    if (Array.isArray(message.capturedByCycleIds) && !message.capturedByCycleIds.includes(cycleId)) return true;
  }
  return false;
}

export async function waitForCalls(client: AlfredClient, cycleId: string, sinceCallId: string | undefined, timeoutMs: number,
                                   until: Until = 'any', quietMs = 0, wake?: Wake | readonly Wake[], options: WaitOptions = {}): Promise<Waited> {
  const cycle = await requireCycle(client, cycleId);
  const first = { entries: await cycleEntries(client, cycle.id) };
  const known = new Set(first.entries.map((e) => e.call.id));
  const wakes: readonly Wake[] = wake === undefined ? [] : 'sockets' in wake ? [wake] : wake;
  const watched = (e: CycleEntry) => !!options.watch?.has(e.call.id) && finished(e.call);
  const after = (entries: CycleEntry[]) => {
    let out: CycleEntry[];
    if (sinceCallId) {
      const at = entries.findIndex((e) => e.call.id === sinceCallId);
      out = at >= 0 ? entries.filter((e, i) => i > at || watched(e)) : entries.filter((e) => !known.has(e.call.id) || watched(e));
    } else {
      out = entries.filter((e) => !known.has(e.call.id) || watched(e));
    }
    if (!quietMs) return out;
    // Waiting for a pause (a listen batch): a call still running is not a reason to return - it cannot be checked yet,
    // and returning for it every few seconds while it runs only costs turns. Its end is a new signal. Like a batch, the
    // wait ends at the first call it must wait for, and a call that hung long ago is passed over.
    const now = client.now();
    const cut = out.findIndex((e) => blocking(e.call, now));
    return (cut >= 0 ? out.slice(0, cut) : out).filter((e) => finished(e.call));
  };
  /** The fresh calls that are what we wait for - by their triage marks when waiting for a kind of trouble. */
  const wanted = async (fresh: CycleEntry[]): Promise<CycleEntry[]> => {
    if (until === 'any') return fresh;
    const inbound = fresh.filter((e) => e.call.source === 'internal');
    if (!inbound.length) return [];
    const marks = await triageOf(client, inbound.map((e) => e.call.id)).catch(() => ({}) as Record<string, TriageEntry>);
    return inbound.filter((e) => marks[e.call.id] && matches(until, signalsOfEntry(marks[e.call.id])));
  };
  const ready = after(first.entries);
  const readyMatched = ready.length ? await wanted(ready) : [];
  if (readyMatched.length && !quietMs) {
    return { newEntries: ready, total: first.entries.length, timedOut: false, recording: cycle.status === 'RECORDING', matched: readyMatched };
  }

  return new Promise((resolve, reject) => {
    const sockets: WebSocket[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let burst: ReturnType<typeof setTimeout> | undefined;
    let early: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let done = false;
    let checking = false;
    let again = false;
    /** With quietMs: what arrived so far - returned once nothing new came for quietMs, or at the timeout. */
    let have: { newEntries: CycleEntry[]; total: number; matched: CycleEntry[] } | null = null;
    /** The fresh calls seen so far: the pause starts over only when this grows. */
    const seen = new Set<string>();
    const finish = (value: { newEntries: CycleEntry[]; total: number; timedOut: boolean; matched: CycleEntry[]; woke?: string } | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settle);
      clearTimeout(quiet);
      clearTimeout(burst);
      clearTimeout(early);
      clearInterval(fallback);
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) {
        try { s.close(); } catch { /* already closed */ }
      }
      if (value instanceof Error) reject(value);
      else resolve({ ...value, recording: cycle.status === 'RECORDING' });
    };
    const returnHave = () => finish({ ...have!, timedOut: false });
    /** Fresh calls arrived: a plain wait is over; a wait for a pause notes them and starts the pause over only if the burst grew. */
    const adopt = (fresh: CycleEntry[], total: number, matched: CycleEntry[]) => {
      const grew = fresh.some((e) => !seen.has(e.call.id));
      for (const e of fresh) seen.add(e.call.id);
      have = { newEntries: fresh, total, matched };
      if (!quietMs) { returnHave(); return; }
      if (grew || quiet === undefined) {
        clearTimeout(quiet);
        quiet = setTimeout(returnHave, quietMs);
      }
      // a burst that never pauses is returned this long after its first call
      burst ??= setTimeout(returnHave, options.burstMs ?? BURST_MAX_MS);
      // a failing call: the rest of its burst is a second away - no reason to wait out the whole pause
      if (early === undefined && options.minStatus !== undefined
        && fresh.some((e) => !!e.call.error || (e.call.response?.status ?? 0) >= options.minStatus!)) {
        early = setTimeout(returnHave, EARLY_GRACE_MS);
      }
    };
    const check = () => {
      if (checking) { again = true; return; }
      checking = true;
      cycleEntries(client, cycle.id).then(async (entries) => {
        const fresh = after(entries);
        if (!fresh.length) return;
        const matched = await wanted(fresh);
        if (!matched.length) return;
        adopt(fresh, entries.length, matched);
      }).catch(finish).finally(() => {
        checking = false;
        if (again && !done) { again = false; check(); }
      });
    };
    const probe = (w: Wake) => w.changed()
      .then((yes) => {
        if (yes) finish({ ...(have ?? { newEntries: [], total: first.entries.length, matched: [] }), timedOut: false, ...(w.label ? { woke: w.label } : {}) });
      })
      .catch(() => undefined);
    const startFallback = () => {
      if (fallback !== undefined || done) return;
      fallback = setInterval(() => { check(); for (const w of wakes) void probe(w); }, options.fallbackMs ?? FALLBACK_MS);
    };
    // At the timeout, calls that already arrived are returned - a user who never pauses still gets them.
    const timer = setTimeout(() => finish(have ? { ...have, timedOut: false } : { newEntries: [], total: first.entries.length, timedOut: true, matched: [] }), timeoutMs);
    if (readyMatched.length) adopt(ready, first.entries.length, readyMatched);
    const wsBase = client.baseUrl.replace(/^http/, 'ws');
    const open = (path: string, onMessage: (data: unknown) => void, onOpen?: () => void) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsBase + path);
      } catch {
        startFallback();
        return;
      }
      socket.addEventListener('message', (event) => onMessage(event.data));
      if (onOpen) socket.addEventListener('open', onOpen);
      socket.addEventListener('close', startFallback);
      socket.addEventListener('error', startFallback);
      sockets.push(socket);
    };
    for (const w of wakes) {
      let wakeSettle: ReturnType<typeof setTimeout> | undefined;
      for (const path of w.sockets) {
        // A burst of messages is asked about once, SETTLE_MS after its first - a flood of them must not postpone the asking for ever
        open(path, () => {
          if (wakeSettle !== undefined) return;
          wakeSettle = setTimeout(() => { wakeSettle = undefined; void probe(w); }, SETTLE_MS);
          timers.add(wakeSettle);
        }, () => void probe(w)); // a change that came before the socket was open would never be heard
      }
      if (w.afterMs !== undefined) timers.add(setTimeout(() => void probe(w), w.afterMs));
    }
    for (const path of until === 'any' ? SOCKETS : [...SOCKETS, ...SIGNAL_SOCKETS]) {
      // A burst of calls arrives as a burst of messages: read the cycle SETTLE_MS after the first, not per message.
      open(path, (data) => {
        if (path !== '/ws/session-cycles' && isNoise(data, cycle.id, quietMs > 0)) return;
        if (settle !== undefined) return;
        settle = setTimeout(() => { settle = undefined; check(); }, SETTLE_MS);
      });
    }
  });
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('wait_for_calls', {
    description: 'Wait (up to timeoutSec, at most 60) until a session cycle captures new calls - e.g. while the user reproduces something with '
      + 'recording on - and return them with their numbers. Pass sinceCallId (the lastCallId of the previous reply) to continue where you left off. '
      + 'Event-driven (Alfred\'s WebSocket signals), not polling; returns timedOut: true when nothing arrived. until waits for a kind of '
      + 'trouble instead of any call: logError (an ERROR line or exception), logWarning, dbFailed, or problem (any error or warning) - matched '
      + 'lists those calls. settleSec waits for a pause: once calls arrived, it returns only after none came for that long (or at the '
      + 'timeout, with what arrived) - one batch per step the user clicks through instead of one reply per call.',
    inputSchema: {
      cycleId: z.string().min(1),
      sinceCallId: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(MAX_WAIT_S).default(30),
      settleSec: z.number().int().min(0).max(30).default(0).describe('Return once no new call came for this long (0 = at the first new call)'),
      includeOptions: z.boolean().default(false),
      until: z.enum(['any', 'logError', 'logWarning', 'dbFailed', 'problem']).default('any'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const result = await waitForCalls(client, input.cycleId, input.sinceCallId, input.timeoutSec * 1000, input.until, input.settleSec * 1000);
    const shown = result.newEntries.filter((e) => input.includeOptions || e.call.method !== 'OPTIONS');
    const rows = maskCalls(ctx, shown.map((e) => e.call)).map(toRow);
    return ok({
      newCalls: rows, newCount: result.newEntries.length, hiddenOptions: result.newEntries.length - shown.length,
      ...(input.until !== 'any' ? { until: input.until, matched: maskCalls(ctx, result.matched.map((e) => e.call)).map(toRow) } : {}),
      totalCalls: result.total, timedOut: result.timedOut, recording: result.recording,
      lastCallId: result.newEntries.at(-1)?.call.id ?? input.sinceCallId ?? null,
      ...(result.recording ? {} : { note: 'The cycle is not recording - start_recording to capture new calls.' }),
      ...maskMeta(ctx),
    });
  }));
}
