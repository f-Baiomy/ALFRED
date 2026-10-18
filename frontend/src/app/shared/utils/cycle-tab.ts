import { CallRecord } from '../../core/models/call.model';
import { CardSummary } from '../../core/models/board.models';
import { BoardCycleRow, CycleEndpoint, CyclePoint, CycleSummary, RetestVerdict } from '../../core/models/cycles-tab.models';
import { CycleSpacer } from '../../core/state/call-selection.tokens';
import { layoutSpacers } from './spacer-gap-controller';

/**
 * The board's Cycles tab (specs/033): the rules behind each row - verdict words, a re-test's name, a description's steps,
 * hot spots, the comparison of two cycles, the "ready to re-test" line, the pause suggestion and the story's steps.
 * Pure functions: the components only show what these say.
 */

export type Tone = 'ok' | 'bad' | 'unk';

export function verdictTone(v: RetestVerdict | null | undefined): Tone {
  if (v === 'PASSES') return 'ok';
  if (v === 'FAILS' || v === 'PARTIAL' || v === 'FLAKY') return 'bad';
  return 'unk';
}

export function verdictWord(v: RetestVerdict | null | undefined): string {
  switch (v) {
    case 'PASSES': return 'passes';
    case 'FAILS': return 'fails';
    case 'PARTIAL': return 'partly passes';
    case 'FLAKY': return 'flaky';
    case 'NO_CALLS': return 'not reached';
    case 'NOT_CHECKABLE': return 'nothing to check';
    default: return 'not checked';
  }
}

/** The name the backend gives a re-test (CycleNaming) - the dialog's preview; the user may edit it. */
export function retestName(cards: readonly { number: number; title: string }[], boardName: string): string {
  if (!cards.length) return `${boardName} · re-test`;
  if (cards.length === 1) return `Re-test #${cards[0].number}${cards[0].title.trim() ? ` · ${cards[0].title.trim().replace(/\s+/g, ' ')}` : ''}`;
  const shown = cards.slice(0, 3).map((c) => `#${c.number}`).join(' ');
  return `Re-test ${shown}${cards.length > 3 ? ` +${cards.length - 3}` : ''} · ${cards.length} cards`;
}

// ------------------------------------------------------------------------------------------------------------- steps

/** A description line `- [ ] text`; `[x]` done by hand, `[-]` not done by hand, `[ ]` ticked by the calls. */
export interface Step {
  readonly line: number;
  readonly mark: ' ' | 'x' | '-';
  readonly text: string;
  readonly endpoint: { readonly method: string; readonly path: string } | null;
}

const STEP = /^\s*[-*]\s+\[( |x|X|-)\]\s+(.*)$/;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`)]*)/i;

export function parseSteps(description: string | null | undefined): Step[] {
  if (!description) return [];
  const out: Step[] = [];
  description.split('\n').forEach((raw, line) => {
    const m = STEP.exec(raw);
    if (!m) return;
    const e = ENDPOINT.exec(m[2]);
    out.push({ line, mark: m[1].toLowerCase() as Step['mark'], text: m[2].trim(),
      endpoint: e ? { method: e[1].toUpperCase(), path: e[2].replace(/\?.*$/, '') } : null });
  });
  return out;
}

/** The description without its step lines - the prose shown above the steps. */
export function descriptionProse(description: string | null | undefined): string {
  if (!description) return '';
  return description.split('\n').filter((l) => !STEP.test(l)).join('\n').trim();
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return pattern.replace(/\/+$/, '') === path.replace(/\/+$/, '');
}

export interface StepState {
  readonly done: boolean;
  /** 'hand' - the user ticked or unticked it; 'calls' - a call did it; null - nothing yet. */
  readonly by: 'hand' | 'calls' | null;
  /** The call that did it, when the calls did. */
  readonly point: CyclePoint | null;
}

export function stepState(step: Step, summary: CycleSummary | null): StepState {
  if (step.mark === 'x') return { done: true, by: 'hand', point: null };
  if (step.mark === '-') return { done: false, by: 'hand', point: null };
  if (!step.endpoint || !summary) return { done: false, by: null, point: null };
  const ep = step.endpoint;
  const point = summary.strip.find((p) => !p.failed && p.method === ep.method && pathMatches(ep.path, p.path)) ?? null;
  return { done: !!point, by: point ? 'calls' : null, point };
}

/** The description with one step marked done or not done by hand. */
export function markStep(description: string, line: number, done: boolean): string {
  const lines = description.split('\n');
  if (line < 0 || line >= lines.length || !STEP.test(lines[line])) return description;
  lines[line] = lines[line].replace(/\[( |x|X|-)\]/, done ? '[x]' : '[-]');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------------- hot spots

export function hotSpots(summary: CycleSummary | null, n = 3): CycleEndpoint[] {
  if (!summary) return [];
  return [...summary.endpoints]
    .filter((e) => e.failed > 0 || (e.maxMs ?? 0) > 0)
    .sort((a, b) => b.failed - a.failed || (b.maxMs ?? 0) - (a.maxMs ?? 0))
    .slice(0, n);
}

// --------------------------------------------------------------------------------------------------------- compare

export interface Comparison {
  readonly totals: readonly { readonly label: string; readonly a: string; readonly b: string; readonly worse: boolean }[];
  readonly statusChanged: readonly { readonly endpoint: string; readonly a: number | null; readonly b: number | null; readonly worse: boolean }[];
  readonly slower: readonly { readonly endpoint: string; readonly a: number; readonly b: number }[];
  readonly onlyA: readonly string[];
  readonly onlyB: readonly string[];
}

const keyOf = (e: CycleEndpoint) => `${e.method} ${e.path}`;
const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`);

/** {@code a} is the baseline (or the earlier cycle), {@code b} the one compared with it. */
export function compareCycles(a: CycleSummary, b: CycleSummary, met?: { a: number; b: number; total: number }): Comparison {
  const totals = [
    { label: 'Calls', a: String(a.calls), b: String(b.calls), worse: false },
    { label: 'Failed (4xx/5xx)', a: String(a.failed), b: String(b.failed), worse: b.failed > a.failed },
    { label: 'Median time', a: ms(a.medianMs), b: ms(b.medianMs), worse: (b.medianMs ?? 0) > (a.medianMs ?? 0) * 1.2 },
    ...(met ? [{ label: 'Requirements met', a: `${met.a} / ${met.total}`, b: `${met.b} / ${met.total}`, worse: met.b < met.a }] : []),
  ];
  const inA = new Map(a.endpoints.map((e) => [keyOf(e), e]));
  const inB = new Map(b.endpoints.map((e) => [keyOf(e), e]));
  const statusChanged: Comparison['statusChanged'][number][] = [];
  const slower: Comparison['slower'][number][] = [];
  for (const [k, eb] of inB) {
    const ea = inA.get(k);
    if (!ea) continue;
    if (ea.lastStatus !== eb.lastStatus) {
      statusChanged.push({ endpoint: k, a: ea.lastStatus, b: eb.lastStatus, worse: (eb.lastStatus ?? 0) >= 400 && (ea.lastStatus ?? 0) < 400 });
    }
    if (ea.medianMs != null && eb.medianMs != null && eb.medianMs > ea.medianMs * 1.5 && eb.medianMs - ea.medianMs > 50) {
      slower.push({ endpoint: k, a: ea.medianMs, b: eb.medianMs });
    }
  }
  return {
    totals, statusChanged, slower,
    onlyA: [...inA.keys()].filter((k) => !inB.has(k)),
    onlyB: [...inB.keys()].filter((k) => !inA.has(k)),
  };
}

/** "vs baseline: 3 more failures", "vs previous: 2 fewer failures, 18% faster" - the row's one line, or null when nothing changed. */
export function versusLine(label: string, base: CycleSummary, now: CycleSummary): string | null {
  const parts: string[] = [];
  const d = now.failed - base.failed;
  if (d > 0) parts.push(`${d} more failure${d > 1 ? 's' : ''}`);
  if (d < 0) parts.push(`${-d} fewer failure${d < -1 ? 's' : ''}`);
  if (base.medianMs && now.medianMs) {
    const pct = Math.round(((now.medianMs - base.medianMs) / base.medianMs) * 100);
    if (pct <= -10) parts.push(`${-pct}% faster`);
    if (pct >= 10) parts.push(`${pct}% slower`);
  }
  return parts.length ? `vs ${label}: ${parts.join(', ')}` : null;
}

// ------------------------------------------------------------------------------------------------ nudges, gently

/**
 * Fixed cards of the board that no re-test has tested since they last changed - the "ready to re-test" line.
 * {@code dismissed}: card ids the user hid the line for; the line comes back only for another card.
 */
export function readyToRetest(cards: readonly CardSummary[], rows: readonly BoardCycleRow[], createdAt: (cycleId: string) => string | null,
                              dismissed: ReadonlySet<string>): CardSummary[] {
  return cards.filter((c) => {
    if (c.status !== 'FIXED' || dismissed.has(c.id)) return false;
    const fixedAt = Date.parse(c.updatedAt);
    return !rows.some((r) => !r.archived && r.tests.some((t) => t.cardId === c.id) && Date.parse(createdAt(r.cycleId) ?? '') >= fixedAt);
  });
}

/** A recording re-test whose every card was checked - "Pause the recording?" once. */
export function pauseSuggested(row: BoardCycleRow | null, recording: boolean): boolean {
  return !!row && recording && row.tests.length > 0
    && row.tests.every((t) => t.verdict != null && t.verdict !== 'NO_CALLS' && t.verdict !== 'NOT_CHECKABLE');
}

/** The environment a cycle ran against, from the first host its calls went to ("env80" of "env80:8080"). */
export function environmentOf(summary: CycleSummary | null): string | null {
  const host = summary?.hosts[0];
  if (!host) return null;
  const name = host.replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' ? 'local' : name;
}

// ------------------------------------------------------------------------------------------------------------ story

export interface StoryStep {
  readonly label: string;
  readonly points: readonly CyclePoint[];
  readonly failed: number;
}

const GAP_MS = 90_000;

/**
 * The calls grouped into steps: by the cycle's spacers (placed by layoutSpacers, as every view of a cycle does), else by
 * pauses of more than 90 s between calls. The calls before the first spacer form a step of their own.
 */
export function storySteps(points: readonly CyclePoint[], spacers: readonly CycleSpacer[]): StoryStep[] {
  const steps: { label: string; points: CyclePoint[] }[] = [];
  if (spacers.length) {
    const asCall = (p: CyclePoint) => ({ id: p.callId, timestamp: p.at ?? '' }) as unknown as CallRecord;
    const { merged } = layoutSpacers(points, asCall, spacers, { descending: false, byTime: true });
    let current: { label: string; points: CyclePoint[] } = { label: 'Start', points: [] };
    for (const m of merged) {
      if (m.kind === 'spacer') {
        if (current.points.length) steps.push(current);
        current = { label: m.spacer.label, points: [] };
      } else {
        current.points.push(m.item);
      }
    }
    if (current.points.length) steps.push(current);
  } else {
    let last = -1;
    for (const p of points) {
      const t = Date.parse(p.at ?? '');
      if (!steps.length || (!Number.isNaN(t) && last >= 0 && t - last > GAP_MS)) steps.push({ label: `Step ${steps.length + 1}`, points: [] });
      steps[steps.length - 1].points.push(p);
      if (!Number.isNaN(t)) last = t;
    }
  }
  return steps.map((s) => ({ ...s, failed: s.points.filter((p) => p.failed).length }));
}
