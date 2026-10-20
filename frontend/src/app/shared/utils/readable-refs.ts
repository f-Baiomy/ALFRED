import { MentionRef } from '../../core/models/board.models';
import { serializeMention } from './mention-syntax';

/**
 * Readable references (specs/021): the shorthand Claude writes - `AC8`, `#47`, `calls #75, #81`, `[6]`, a call id - found
 * in a text, so each can become the mention it means, with a few words of meaning: "one-branch search (AC8)".
 *
 * One finder for both ends: the MCP server turns what it finds into real mentions before a text is saved (looked up,
 * so the label is the meaning), and the board draws what is left in older text the same way, looked up on display.
 * Code, links and existing mentions are never touched.
 */
export type BareKind = 'ac' | 'card' | 'cycleCall' | 'history' | 'uuid' | 'shortId' | 'workitem';

export interface BareRef {
  readonly kind: BareKind;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  /** AC / card / call / history number. */
  readonly n?: number;
  /** A call id (whole UUID or its first 8 characters). */
  readonly id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every bare reference in the text, in order, outside code, links and mentions. */
export function findBareRefs(text: string | null | undefined): BareRef[] {
  if (!text) return [];
  const out: BareRef[] = [];
  for (const [from, to] of plainRanges(text)) {
    const part = text.slice(from, to);
    const taken: [number, number][] = [];
    const add = (r: BareRef) => {
      if (taken.some(([a, b]) => r.start < b && r.end > a)) return;
      taken.push([r.start, r.end]);
      out.push(r);
    };
    // "call #75", "calls #75, #81 and #88", "calls #40-#61": the cycle's own numbering, never cards
    for (const m of part.matchAll(/\b[Cc]alls?\s+#\d+(?:\s*(?:,|and|&|or|\/|-|–|to)\s*#\d+)*/g)) {
      for (const h of m[0].matchAll(/#(\d+)/g)) {
        const start = from + m.index! + h.index!;
        add({ kind: 'cycleCall', start, end: start + h[0].length, raw: h[0], n: Number(h[1]) });
      }
    }
    // "AB#62565": an Azure DevOps work item (its own id space - never a card)
    for (const m of part.matchAll(/\bAB#(\d{1,9})(?![\w-])/g)) {
      add({ kind: 'workitem', start: from + m.index!, end: from + m.index! + m[0].length, raw: m[0], n: Number(m[1]) });
    }
    for (const m of part.matchAll(/\bAC(\d{1,3})\b/g)) {
      add({ kind: 'ac', start: from + m.index!, end: from + m.index! + m[0].length, raw: m[0], n: Number(m[1]) });
    }
    for (const m of part.matchAll(/(^|[^\w&/#\]\\])#(\d{1,5})(?![\w-])/g)) {
      const start = from + m.index! + m[1].length;
      add({ kind: 'card', start, end: start + m[2].length + 1, raw: `#${m[2]}`, n: Number(m[2]) });
    }
    for (const m of part.matchAll(/(^|[^\w\]!\\])\[(\d{1,4})\](?![([]|:\s*https?:)/g)) {
      const start = from + m.index! + m[1].length;
      add({ kind: 'history', start, end: start + m[2].length + 2, raw: `[${m[2]}]`, n: Number(m[2]) });
    }
    for (const m of part.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      add({ kind: 'uuid', start: from + m.index!, end: from + m.index! + m[0].length, raw: m[0], id: m[0].toLowerCase() });
    }
    for (const m of part.matchAll(/(^|[^\w-])([0-9a-f]{8})(?![\w-])/g)) {
      if (!/\d/.test(m[2]) || !/[a-f]/.test(m[2])) continue;
      const start = from + m.index! + m[1].length;
      add({ kind: 'shortId', start, end: start + 8, raw: m[2], id: m[2] });
    }
  }
  // "(AC8)" / "(#47)": the chip says the code in parentheses already - take the parentheses with it, or it reads "((AC8))"
  return out.sort((a, b) => a.start - b.start).map((r) => (r.kind === 'ac' || r.kind === 'card') && text[r.start - 1] === '(' && text[r.end] === ')'
    ? { ...r, start: r.start - 1, end: r.end + 1, raw: `(${r.raw})` } : r);
}

/** The text with each found reference replaced by what `to` gives for it (a mention, or text); null keeps it as written. */
export function replaceBareRefs(text: string, refs: readonly BareRef[], to: (r: BareRef) => MentionRef | string | null): string {
  let out = '';
  let at = 0;
  for (const r of refs) {
    const next = to(r);
    if (next === null) continue;
    out += text.slice(at, r.start) + (typeof next === 'string' ? next : serializeMention(next));
    at = r.end;
  }
  return out + text.slice(at);
}

export interface RefContext {
  readonly project?: string | null;
  readonly cycleId?: string | null;
  /** The card the text is on - for `[6]`, an entry of its own history. */
  readonly card?: number | null;
}

/**
 * Older text drawn readable (the board, on display): each bare code becomes a mention to be looked up - its chip fetches
 * the meaning. What cannot be placed (no cycle for an AC, no project for a card) stays as written.
 */
/** A work item ref whose connection is the board's Azure one, found when it is read (`AB#n` names no connection). */
export const ANY_CONN = '*';

export function withBareRefs(text: string, ctx: RefContext): string {
  if (!text || !/(AC\d|#\d|\[\d)/.test(text)) return text;
  const refs = findBareRefs(text);
  if (!refs.length) return text;
  return replaceBareRefs(text, refs, (r) => {
    if (r.kind === 'workitem') return { type: 'workitem', ref: `${ANY_CONN}/${r.n}`, label: `AB#${r.n}` };
    if (r.kind === 'ac' && ctx.cycleId) return { type: 'spec', ref: `${ctx.cycleId}/*#ac${r.n}`, label: `AC${r.n}` };
    if (r.kind === 'card' && ctx.project) return { type: 'card', ref: `${ctx.project}#${r.n}`, label: `#${r.n}` };
    if (r.kind === 'cycleCall' && ctx.cycleId) return { type: 'call', ref: `n:${r.n}@${ctx.cycleId}`, label: `call ${r.n}` };
    if (r.kind === 'history' && ctx.project && ctx.card) return { type: 'card', ref: `${ctx.project}#${ctx.card}/i${r.n}`, label: 'an earlier comment' };
    return null;
  });
}

// ---------------------------------------------------------------------------------------------------------- labels

const LEAD = /^(not exercised|missing feature|wrong result|no data|not in this flow|re-?test|fixed|bug|task)\s*[:-]\s*/i;

/**
 * A short name made from a long text when none was given: the lead-in ("Not exercised:") and any trailing "(AC8)" or
 * "(and 1 more)" dropped, the first four words kept.
 */
export function shortOf(text: string | null | undefined): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim().replace(LEAD, '');
  t = t.replace(/\s*\((?:AC\d+[^)]*|and \d+ more|#\d+)\)\s*$/i, '').replace(/[.:;,]+$/, '');
  const words = t.split(' ').filter(Boolean).slice(0, 4);
  let s = words.join(' ');
  if (s.length > 40) s = s.slice(0, 39).trimEnd() + '…';
  // "Searching with…" reads as "searching with…" inside a sentence; an acronym ("PNR filter") keeps its case
  return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

export const acLabel = (short: string, n: number): string => `${short} (AC${n})`;
export const cardLabel = (short: string, n: number): string => `${short} (#${n})`;

/** "POST refunded-requests/search · 200" - a call in a few words. */
export function callMeaning(method: string | null | undefined, url: string | null | undefined, status: number | string | null | undefined): string {
  const path = (url ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/') || path || '/';
  return `${method ?? ''} ${tail}${status === null || status === undefined || status === '' ? '' : ` · ${status}`}`.trim();
}

export const cycleCallLabel = (meaning: string, n: number): string => `${meaning} (call ${n})`;

/** "your answer · 15 Oct 4:38 PM" - a history entry by who wrote it and when, never its index. */
export function entryLabel(actor: string | null | undefined, kind: string | null | undefined, at: string | null | undefined, text?: string | null): string {
  const who = actor === 'CLAUDE' ? "Claude's" : 'your';
  const what = kind === 'COMMENT' || !kind
    ? (/^\*\*(Answers?)\*\*/.test(text ?? '') ? 'answer' : /^\*\*Questions?\*\*/.test(text ?? '') || /```questions/.test(text ?? '') ? 'question' : 'comment')
    : kind.toLowerCase().replace(/_/g, ' ');
  const when = at ? new Date(at) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? `${when.getDate()} ${when.toLocaleString('en', { month: 'short' })} ${when.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${who} ${what}${time ? ` · ${time}` : ''}`;
}

// ------------------------------------------------------------------------------------------------------ the refs

/** `n:75@<cycle>`: call 75 of a cycle, by the cycle's own numbering - looked up before it opens. */
export function cycleCallOf(ref: MentionRef): { n: number; cycleId: string } | null {
  if (ref.type.toLowerCase() !== 'call') return null;
  const m = /^n:(\d+)@(.+)$/.exec(ref.ref);
  return m ? { n: Number(m[1]), cycleId: m[2] } : null;
}

/** An Acceptance item's number from a spec mention's section (`#ac8`), else null. */
export function acOf(section: string | null | undefined): number | null {
  const m = /^ac(\d+)$/i.exec(section ?? '');
  return m ? Number(m[1]) : null;
}

/** A cycle's calls in the order its numbers count them: no CORS preflight, oldest first - as get_cycle numbers them. */
export function numberedCalls<T extends { readonly method?: string | null }>(entries: readonly T[], time: (e: T) => number): T[] {
  return entries.filter((e) => e.method !== 'OPTIONS').sort((a, b) => time(a) - time(b));
}

export const isUuid = (s: string): boolean => UUID.test(s);

// ---------------------------------------------------------------------------------------------------------- scan

/** The parts of a text outside fenced code, inline code, links, URLs, HTML tags and mentions. */
function plainRanges(text: string): [number, number][] {
  const skip: [number, number][] = [];
  const mark = (re: RegExp) => {
    for (const m of text.matchAll(re)) skip.push([m.index!, m.index! + m[0].length]);
  };
  mark(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|$(?![\s\S]))/gm);
  mark(/`[^`\n]*`/g);
  mark(/@\[[a-z]+:[^\n]*?[^\\]\]/g);
  mark(/\]\([^)\n]*\)/g);
  mark(/\bhttps?:\/\/[^\s)]+/g);
  mark(/<[^>\n]+>/g);
  skip.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of skip) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < text.length) out.push([at, text.length]);
  return out;
}
