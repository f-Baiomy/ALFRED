import { findLoose } from './task-view';

/**
 * The brief's commented passages, marked with the CSS Custom Highlight API (specs/024): ranges over the rendered text,
 * never a change to the DOM Angular owns - wrapping text nodes in <mark> would break its bindings on the next update.
 * A browser without the API shows no highlight; the comments still say which passage they are about.
 */

export type HighlightKind = 'user' | 'claude' | 'lit';

export interface QuoteRange {
  readonly id: number;
  readonly range: Range;
}

const NAMES: Record<HighlightKind, string> = { user: 'brief-c', claude: 'brief-cl', lit: 'brief-lit' };

/** The browser's highlight registry, or null where the API is missing (older browsers, the test DOM). */
function registry(): Map<string, Highlight> | null {
  // the DOM typings declare the registry without its map methods; it is a maplike in every browser that has it
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined'
    ? CSS.highlights as unknown as Map<string, Highlight> : null;
}

/** Each quote's range in the container's rendered text (whitespace matched loosely); a quote not found has none. */
export function quoteRanges(container: HTMLElement, quotes: readonly { id: number; quote: string }[]): QuoteRange[] {
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  const at = (offset: number, end: boolean): { node: Text; offset: number } | null => {
    for (let i = 0; i < nodes.length; i++) {
      const { node, start } = nodes[i];
      const stop = start + node.data.length;
      if (offset < stop || (end && offset === stop)) return { node, offset: offset - start };
    }
    return null;
  };
  const out: QuoteRange[] = [];
  for (const q of quotes) {
    const found = findLoose(text, q.quote);
    if (!found) continue;
    const a = at(found.start, false);
    const b = at(found.end, true);
    if (!a || !b) continue;
    const range = container.ownerDocument.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    out.push({ id: q.id, range });
  }
  return out;
}

/** Paints the ranges: the user's threads amber, Claude's violet, the one in focus stronger. */
export function paintHighlights(byKind: Record<HighlightKind, readonly Range[]>): void {
  const r = registry();
  if (!r) return;
  for (const kind of Object.keys(NAMES) as HighlightKind[]) {
    if (byKind[kind].length) r.set(NAMES[kind], new Highlight(...byKind[kind]));
    else r.delete(NAMES[kind]);
  }
}

export function clearHighlights(): void {
  const r = registry();
  if (!r) return;
  for (const name of Object.values(NAMES)) r.delete(name);
}

/** The thread whose passage is under the pointer. */
export function rangeAt(ranges: readonly QuoteRange[], x: number, y: number): number | null {
  for (const q of ranges) {
    for (const rect of Array.from(q.range.getClientRects())) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return q.id;
    }
  }
  return null;
}
