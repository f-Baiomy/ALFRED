import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { toRow, withParts, type Direction } from '../calls.ts';
import { diffHeaders, diffLines, sharedBodyKind, type CallRecord, type DiffLine } from '../frontend.ts';
import { maskCall, maskContext, maskMeta } from '../masking.ts';
import { ok, REPLY_BUDGET, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';
import { resolveCall } from './calls.ts';

/**
 * Two calls side by side - "why did the first login get 401 and the retry 200?". The header and
 * body diffs are the frontend's own (interception-diff.ts: case-insensitive headers, bodies
 * pretty-printed as JSON/XML before a line diff), so a one-field change is one changed line.
 */

export interface Hunk {
  /** 1-based first line of the hunk on each side. */
  readonly a: number;
  readonly b: number;
  readonly lines: string[];
}

/** Unified-diff style hunks: changed lines with `context` unchanged lines around them, in order. */
export function hunksOf(lines: readonly DiffLine[], context: number): Hunk[] {
  const numbered: { kind: DiffLine['kind']; text: string; a: number; b: number }[] = [];
  let a = 0;
  let b = 0;
  for (const line of lines) {
    if (line.kind !== 'added') a++;
    if (line.kind !== 'removed') b++;
    numbered.push({ kind: line.kind, text: line.text, a, b });
  }
  const keep = new Set<number>();
  numbered.forEach((line, i) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k++) keep.add(k);
  });
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let last = -2;
  for (const i of [...keep].sort((x, y) => x - y)) {
    const line = numbered[i];
    if (!current || i !== last + 1) {
      current = { a: line.kind === 'added' ? line.a + 1 : line.a, b: line.kind === 'removed' ? line.b + 1 : line.b, lines: [] };
      hunks.push(current);
    }
    current.lines.push(`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`);
    last = i;
  }
  return hunks;
}

function sideDiff(a: CallRecord, b: CallRecord, side: 'request' | 'response', context: number) {
  const ha = side === 'request' ? a.request?.headers : a.response?.headers;
  const hb = side === 'request' ? b.request?.headers : b.response?.headers;
  const ba = (side === 'request' ? a.request?.body : a.response?.body) ?? '';
  const bb = (side === 'request' ? b.request?.body : b.response?.body) ?? '';
  const headerRows = diffHeaders(ha, hb);
  const kind = sharedBodyKind(ba, bb);
  const body = diffLines(ba, bb, kind, false);
  const changed = body.filter((l) => l.kind !== 'same').length;
  return {
    headers: {
      // diffHeaders reports a changed value as removed (a's) plus added (b's) - kept that way, named by side.
      changed: headerRows.filter((r) => r.kind !== 'same').map((r) => ({ name: r.name, onlyIn: r.kind === 'removed' ? 'a' as const : 'b' as const, value: r.value })),
      same: headerRows.filter((r) => r.kind === 'same').length,
    },
    body: {
      kind, identical: changed === 0, lengths: { a: ba.length, b: bb.length }, changedLines: changed,
      hunks: hunksOf(body, context),
    },
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('diff_calls', {
    description: 'Compare two calls (live or in cycles): method, URL, status, duration, then request and response headers and bodies as a '
      + 'unified diff (bodies pretty-printed as JSON/XML first, so one changed field is one changed line). A header that differs appears '
      + 'twice: onlyIn a (its value there) and onlyIn b. Page long diffs with hunkOffset.',
    inputSchema: {
      a: z.string().min(1).describe('First call id'),
      b: z.string().min(1).describe('Second call id'),
      aDirection: z.enum(['inbound', 'outbound']).optional(),
      bDirection: z.enum(['inbound', 'outbound']).optional(),
      aCycleId: z.string().optional().describe('Read call a from this cycle'),
      bCycleId: z.string().optional(),
      part: z.enum(['request', 'response', 'both']).default('both'),
      context: z.number().int().min(0).max(10).default(2).describe('Unchanged lines shown around each change'),
      hunkOffset: z.number().int().min(0).default(0).describe('Skip this many body hunks (per side) - for paging a long diff'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const load = async (id: string, direction: Direction | undefined, cycleId: string | undefined) => {
      const { ref, call } = await resolveCall(client, id, direction, cycleId);
      return maskCall(ctx, await withParts(client, ref, call, 'all'));
    };
    const [a, b] = await Promise.all([load(input.a, input.aDirection, input.aCycleId), load(input.b, input.bDirection, input.bCycleId)]);
    const ra = toRow(a);
    const rb = toRow(b);
    const sides = (input.part === 'both' ? ['request', 'response'] as const : [input.part] as const)
      .map((side) => [side, sideDiff(a, b, side, input.context)] as const);

    // Hunks are cut to the reply budget, never silently: nextHunkOffset says where to continue.
    let size = 1500;
    let cut = false;
    const out: Record<string, unknown> = {};
    for (const [side, diff] of sides) {
      const hunks = diff.body.hunks.slice(input.hunkOffset);
      const kept: Hunk[] = [];
      size += JSON.stringify(diff.headers).length;
      for (const h of hunks) {
        const hSize = JSON.stringify(h).length;
        if (size + hSize > REPLY_BUDGET - 200) { cut = true; break; }
        kept.push(h);
        size += hSize;
      }
      out[side] = { headers: diff.headers, body: { ...diff.body, hunks: kept, totalHunks: diff.body.hunks.length, ...(kept.length < hunks.length ? { nextHunkOffset: input.hunkOffset + kept.length } : {}) } };
    }
    return ok({
      a: ra, b: rb,
      changes: {
        ...(a.method !== b.method ? { method: `${a.method} → ${b.method}` } : {}),
        ...(ra.url !== rb.url ? { url: { a: ra.url, b: rb.url } } : {}),
        ...(ra.status !== rb.status ? { status: `${ra.status ?? a.error ?? '-'} → ${rb.status ?? b.error ?? '-'}` } : {}),
        durationMs: { a: ra.durationMs, b: rb.durationMs },
      },
      ...out,
      ...(cut ? { note: 'Some body hunks did not fit - call again with each side\'s nextHunkOffset.' } : {}),
      ...maskMeta(ctx),
    });
  }));
}
