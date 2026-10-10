import { MentionRef } from '../../core/models/board.models';
import { parseMentions, slug } from './mention-syntax';

/**
 * The Markdown subset the board shows (descriptions, comments, briefs, spec files) as a typed tree, rendered with
 * plain Angular bindings by MarkdownViewComponent - never innerHTML, since spec files and Claude's text are untrusted
 * (constitution I, research R7). Links are kept only for http(s) URLs; anything else stays text.
 */
export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly children: readonly Inline[] }
  | { readonly kind: 'italic'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: 'mention'; readonly ref: MentionRef };

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly slug: string; readonly inlines: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'table'; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly kind: 'rule' };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function markdownBlocks(text: string | null | undefined): Block[] {
  const lines = (text ?? '').split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line.trim());
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, slug: slug(heading[2]), inlines: inlines(heading[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = cells(line).map(inlines);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]).map(inlines));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(inlines(pattern.exec(lines[i++])![1]));
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i].trim())
      && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push({ kind: 'paragraph', inlines: inlines(para.join('\n')) });
  }
  return blocks;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Mentions first (their labels may hold Markdown characters), then code, links, bold and italic in the text between. */
export function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  for (const segment of parseMentions(text)) {
    if ('mention' in segment) out.push({ kind: 'mention', ref: segment.mention });
    else out.push(...formatted(segment.text));
  }
  return out;
}

const TOKEN = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

function formatted(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) {
      out.push({ kind: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) });
    const token = m[0];
    if (m[1]) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (m[2]) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      if (/^https?:\/\//i.test(href)) out.push({ kind: 'link', href, children: formatted(label) });
      else out.push({ kind: 'text', text: token });
    } else if (m[3] || m[4]) {
      out.push({ kind: 'bold', children: formatted(token.slice(2, -2)) });
    } else {
      out.push({ kind: 'italic', children: formatted(token.slice(1, -1)) });
    }
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

/** The plain text of inlines - for exports, titles and tests. */
export function plainText(nodes: readonly Inline[]): string {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text':
      case 'code':
        return n.text;
      case 'mention':
        return n.ref.label;
      default:
        return plainText(n.children);
    }
  }).join('');
}
