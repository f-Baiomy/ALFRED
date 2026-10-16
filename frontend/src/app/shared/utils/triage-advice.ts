import { CardSummary, Resolution } from '../../core/models/board.models';

/**
 * Claude's triage advice on an Inbox card, as an action the board can take (skills/alfred-triage): sort it, merge it
 * into another card, or merge its root-cause group into it. The advice is the label of the option Claude recommends in
 * its open Triage question; taking the action answers that question (the backend matches the label).
 */
export type TriageAction =
  | { readonly kind: 'close'; readonly resolution: Resolution }
  | { readonly kind: 'move'; readonly status: 'TO_DO' }
  | { readonly kind: 'merge'; readonly into: number }
  | { readonly kind: 'mergeGroup'; readonly group: readonly number[] };

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

const CONFIDENCE_LABELS: Record<Confidence, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/** HIGH / MEDIUM / LOW from whatever case Claude wrote, or null. */
export function confidenceOf(card: Pick<CardSummary, 'adviceDetail'> | null | undefined): Confidence | null {
  const c = String(card?.adviceDetail?.confidence ?? '').trim().toUpperCase();
  return c === 'HIGH' || c === 'MEDIUM' || c === 'LOW' ? c : null;
}

export function confidenceLabel(c: Confidence | string | null | undefined): string {
  const k = String(c ?? '').trim().toUpperCase() as Confidence;
  return CONFIDENCE_LABELS[k] ?? '';
}

/** What the advice asks for: "To do", "Fine", "Not in this flow", "Merge into #12", "Merge #14 #17 into #12". */
export function adviceAction(card: Pick<CardSummary, 'number' | 'advice' | 'adviceDetail' | 'openQuestions'>): TriageAction | null {
  if (!card.openQuestions) return null;
  const label = card.advice ?? card.adviceDetail?.option ?? '';
  const a = label.toLowerCase().replace(/[^a-z0-9# ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (a === 'to do' || a.startsWith('to do ')) return { kind: 'move', status: 'TO_DO' };
  if (a === 'fine' || a.startsWith('fine ')) return { kind: 'close', resolution: 'FINE' };
  if (a.startsWith('not in this flow') || a.startsWith('not in flow')) return { kind: 'close', resolution: 'NOT_IN_FLOW' };
  if (!a.startsWith('merge')) return null;
  const into = /into #?(\d+)/.exec(a);
  const target = into ? Number(into[1]) : null;
  if (target != null && target !== card.number) return { kind: 'merge', into: target };
  const group = (card.adviceDetail?.group?.length ? [...card.adviceDetail.group]
    : [...a.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))).filter((n) => n !== card.number);
  return group.length ? { kind: 'mergeGroup', group } : null;
}

/** "To do", "Fine", "Merge into #12", "Merge #14 #17 here". */
export function actionText(a: TriageAction): string {
  if (a.kind === 'move') return 'To do';
  if (a.kind === 'close') return a.resolution === 'FINE' ? 'Fine' : a.resolution === 'NOT_IN_FLOW' ? 'Not in this flow' : "Won't fix";
  if (a.kind === 'merge') return `Merge into #${a.into}`;
  return `Merge ${a.group.map((n) => '#' + n).join(' ')} here`;
}

/** The Inbox worst first when Claude ranked it: ranked cards by rank, then the rest in their order. */
export function worstFirst<T extends Pick<CardSummary, 'adviceDetail'>>(cards: readonly T[]): T[] {
  const rank = (c: T) => c.adviceDetail?.rank ?? Number.POSITIVE_INFINITY;
  return cards.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
}

/** Inbox cards whose open advice is High confidence and can be taken in one click - what "Accept all High" applies. */
export function highCards<T extends CardSummary>(cards: readonly T[]): T[] {
  return cards.filter((c) => c.status === 'INBOX' && confidenceOf(c) === 'HIGH' && adviceAction(c) != null);
}
