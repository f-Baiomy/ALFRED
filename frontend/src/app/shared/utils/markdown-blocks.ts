import { MentionRef } from '../../core/models/board.models';
import { CodeToken, codeTokens, jsonCodeTokens, langOf } from './code-highlight';
import { parseMentions, slug } from './mention-syntax';
import { ACTION_LINE, ActionChip, CALLVIEW_LINE, CHOOSE_LINE, PROGRESS_LINE, VisualLang, WIDGET_LINE, infoAttrs, isLineBlock, parseActions, visualLangOf } from './board-visuals';

/** A file attached on the board (specs/017 R36): the one relative link a text keeps; drawn as a file chip. */
export const BOARD_FILE = /^\/board\/files\/[A-Za-z0-9-]{8,64}$/;

/**
 * The board's text (descriptions, comments, briefs, spec files) as a typed tree, rendered with plain Angular bindings by
 * MarkdownViewComponent - never innerHTML, since spec files and Claude's text are untrusted (constitution I, research R7).
 * Two ways in, one tree: Markdown (everything written before rich text, and what Claude writes) here, and the editor's
 * HTML in rich-html.ts (docs/board.md "Rich text"). Links are kept only for http(s) / mailto; pictures only Alfred's own.
 */
export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly children: readonly Inline[] }
  | { readonly kind: 'italic'; readonly children: readonly Inline[] }
  | { readonly kind: 'underline'; readonly children: readonly Inline[] }
  | { readonly kind: 'strike'; readonly children: readonly Inline[] }
  | { readonly kind: 'mark'; readonly children: readonly Inline[] }
  | { readonly kind: 'sub'; readonly children: readonly Inline[] }
  | { readonly kind: 'sup'; readonly children: readonly Inline[] }
  | { readonly kind: 'kbd'; readonly children: readonly Inline[] }
  | { readonly kind: 'color'; readonly color: TextColor; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: 'mention'; readonly ref: MentionRef }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'pill'; readonly tone: PillTone; readonly text: string }
  | { readonly kind: 'br' };

export type TextColor = 'red' | 'green' | 'amber' | 'blue' | 'purple';
export type PillTone = 'ok' | 'fail' | 'wait' | 'info';
export type CalloutTone = 'info' | 'warn' | 'bug' | 'ok' | 'next';

export const TEXT_COLORS: readonly TextColor[] = ['red', 'green', 'amber', 'blue', 'purple'];
export const PILL_TONES: readonly PillTone[] = ['ok', 'fail', 'wait', 'info'];
export const CALLOUT_TONES: readonly CalloutTone[] = ['info', 'warn', 'bug', 'ok', 'next'];
export const CALLOUT_TITLES: Record<CalloutTone, string> = { info: 'Note', warn: 'Warning', bug: 'What goes wrong', ok: 'Fixed', next: 'Next' };
export const PILL_LABELS: Record<PillTone, string> = { ok: 'ok', fail: 'fail', wait: 'waiting', info: 'info' };

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly slug: string; readonly inlines: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly Inline[] }
  /** {@code checks}: a checklist - true ticked, false open, per item. */
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[]; readonly checks?: readonly boolean[] }
  | { readonly kind: 'code'; readonly text: string; readonly lang: string; readonly json: readonly JsonToken[] | null; readonly tokens?: readonly CodeToken[] | null }
  | { readonly kind: 'quote'; readonly inlines: readonly Inline[] }
  | { readonly kind: 'facts'; readonly facts: readonly Fact[] }
  | { readonly kind: 'table'; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'callout'; readonly tone: CalloutTone; readonly title: readonly Inline[]; readonly blocks: readonly Block[] }
  | { readonly kind: 'fold'; readonly summary: readonly Inline[]; readonly blocks: readonly Block[] }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  /** A fenced block the board draws (specs/017): ```chart, ```stats … or a ```html live snippet; {@code text} is its source. */
  | { readonly kind: 'visual'; readonly lang: VisualLang; readonly info: string; readonly text: string }
  | { readonly kind: 'progress'; readonly value: number; readonly max: number; readonly label: string }
  | { readonly kind: 'tabs'; readonly tabs: readonly { readonly title: string; readonly blocks: readonly Block[] }[] }
  /** `[choose: A | B]` - one click answers as the user's reply. */
  | { readonly kind: 'choices'; readonly options: readonly string[] }
  /** `[action: retest | Re-test now]` chips - each asks the user before it runs. */
  | { readonly kind: 'actions'; readonly items: readonly ActionChip[] }
  /** `!@[call:…]` alone on a line - the expanded call view. */
  | { readonly kind: 'callview'; readonly ref: MentionRef }
  /** `{{widget:name | key=value}}` alone on a line - a project widget, its `{{key}}`s filled from `params`. */
  | { readonly kind: 'widget'; readonly name: string; readonly args: string; readonly params: Readonly<Record<string, string>> };

/** One fact of a `> a · b · c` line - shown as a pill, red for a failure, amber for a stop or a gap. */
export interface Fact {
  readonly inlines: readonly Inline[];
  readonly tone: 'bad' | 'warn' | null;
}

/** A piece of a pretty-printed JSON code block, coloured like the call card's bodies. */
export interface JsonToken {
  readonly text: string;
  readonly kind: 'key' | 'string' | 'number' | 'bool' | 'null' | null;
}

/** A picture stored in Alfred - the only kind a board text shows. */
export const BOARD_IMAGE = /^\/board\/images\/[A-Za-z0-9-]{8,64}$/;

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE_LANG = /^\s*```\s*([\w+#-]*)\s*(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const CHECK = /^\[([ xX])\]\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CALLOUT = /^\[!(note|info|tip|warning|warn|caution|bug|danger|error|fixed|ok|success|next|important)\]\s*(.*)$/i;
const FOLD = /^\s*\+\+\+\s*(.*)$/;
const IMAGE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/;

const CALLOUT_OF: Record<string, CalloutTone> = {
  note: 'info', info: 'info', tip: 'ok', important: 'warn', warning: 'warn', warn: 'warn', caution: 'warn', bug: 'bug', danger: 'bug',
  error: 'bug', fixed: 'ok', ok: 'ok', success: 'ok', next: 'next',
};

/** A whole text that is one HTML page (specs/017 R9): its first line is this marker. */
export const PAGE_MARKER = /^\s*<!--\s*alfred:page\s*-->[ \t]*(?:\r?\n|$)/i;

export function markdownBlocks(text: string | null | undefined): Block[] {
  if (text && PAGE_MARKER.test(text)) return [{ kind: 'visual', lang: 'html', info: 'live page', text: text.replace(PAGE_MARKER, '') }];
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
      const m = FENCE_LANG.exec(line)!;
      const lang = m[1].toLowerCase();
      const info = (m[2] ?? '').trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++;
      const visual = visualLangOf(lang, info);
      blocks.push(visual ? { kind: 'visual', lang: visual, info, text: code.join('\n') } : codeBlock(code.join('\n'), lang));
      continue;
    }
    if (/^\s*:::\s*tabs\s*$/i.test(line)) {
      const inner: string[] = [];
      i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) inner.push(lines[i++]);
      i++;
      blocks.push(tabsBlock(inner));
      continue;
    }
    const lineBlock = lineBlockOf(line);
    if (lineBlock) {
      blocks.push(lineBlock);
      i++;
      continue;
    }
    const fold = FOLD.exec(line);
    if (fold) {
      const inner: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\+\+\+\s*$/.test(lines[i])) inner.push(lines[i++]);
      i++;
      blocks.push({ kind: 'fold', summary: inlines(fold[1].trim() || 'Details'), blocks: markdownBlocks(inner.join('\n')) });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push(quoteBlock(quoted));
      continue;
    }
    const image = IMAGE.exec(line);
    if (image && BOARD_IMAGE.test(image[2])) {
      blocks.push({ kind: 'image', src: image[2], alt: image[1] });
      i++;
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
      const checks: (boolean | null)[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        const item = pattern.exec(lines[i++])![1];
        const check = ordered ? null : CHECK.exec(item);
        checks.push(check ? check[1] !== ' ' : null);
        items.push(inlines(check ? check[2] : item));
      }
      const checklist = checks.length > 0 && checks.every((c) => c !== null);
      blocks.push(checklist ? { kind: 'list', ordered, items, checks: checks as boolean[] } : { kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i].trim())
      && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !QUOTE.test(lines[i]) && !FOLD.test(lines[i]) && !isLineBlock(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push({ kind: 'paragraph', inlines: inlines(para.join('\n')) });
  }
  return blocks;
}

/** `[progress: …]`, `[choose: …]`, `[action: …]` and `!@[call:…]` - a whole line that is a block of its own. */
export function lineBlockOf(line: string): Block | null {
  const progress = PROGRESS_LINE.exec(line);
  if (progress) return { kind: 'progress', value: Number(progress[1]), max: Number(progress[2]) || 1, label: progress[3].trim() };
  const widget = WIDGET_LINE.exec(line);
  if (widget) {
    const args = (widget[2] ?? '').trim();
    return { kind: 'widget', name: widget[1], args, params: infoAttrs(args.replace(/\s*[|;]\s*/g, ' ')) };
  }
  const choose = CHOOSE_LINE.exec(line);
  if (choose) {
    const options = choose[1].split('|').map((o) => o.trim()).filter(Boolean);
    if (options.length) return { kind: 'choices', options };
  }
  if (ACTION_LINE.test(line)) {
    const items = parseActions(line);
    if (items.length) return { kind: 'actions', items };
  }
  const call = CALLVIEW_LINE.exec(line);
  if (call) {
    const seg = parseMentions(call[1])[0];
    if (seg && 'mention' in seg) return { kind: 'callview', ref: seg.mention };
  }
  return null;
}

/** `:::tabs` … `:::` - each `## Title` opens a tab; text before the first title is a tab named "Overview". */
function tabsBlock(lines: string[]): Block {
  const tabs: { title: string; body: string[] }[] = [];
  for (const l of lines) {
    const h = /^\s*##\s+(.*)$/.exec(l);
    if (h) tabs.push({ title: h[1].trim(), body: [] });
    else if (tabs.length) tabs[tabs.length - 1].body.push(l);
    else if (l.trim()) tabs.push({ title: 'Overview', body: [l] });
  }
  return { kind: 'tabs', tabs: tabs.map((t) => ({ title: t.title, blocks: markdownBlocks(t.body.join('\n')) })) };
}

/** A ```json block that parses is pretty-printed and coloured; other languages coloured as written; anything else stays text. */
export function codeBlock(text: string, lang: string): Block {
  const l = langOf(lang);
  if (l === 'json') {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return { kind: 'code', text: pretty, lang: 'json', json: jsonTokens(pretty) };
    } catch {
      // not JSON after all - shown as written
    }
    return { kind: 'code', text, lang: 'json', json: null };
  }
  const tokens = codeTokens(text, l);
  return tokens ? { kind: 'code', text, lang, json: null, tokens } : { kind: 'code', text, lang, json: null };
}

/** Tokens of pretty-printed JSON - every character kept, in order, so the text reads exactly as JSON.stringify wrote it. */
export function jsonTokens(text: string): JsonToken[] {
  return jsonCodeTokens(text) as JsonToken[];
}

const BAD_FACT = /\b[45]\d\d\b|fail|error|exception|crash|lost/i;
const WARN_FACT = /stop|block|no log|missing|slow|retr|warn|gap|skipp/i;

/** `> [!BUG] title` is a callout; `> a · b · c` is a line of facts (pills); any other quote stays a quote. */
function quoteBlock(lines: string[]): Block {
  const callout = CALLOUT.exec(lines[0]?.trim() ?? '');
  if (callout) {
    const tone = CALLOUT_OF[callout[1].toLowerCase()] ?? 'info';
    return { kind: 'callout', tone, title: inlines(callout[2].trim()), blocks: markdownBlocks(lines.slice(1).join('\n')) };
  }
  const text = lines.join('\n');
  const parts = text.split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { kind: 'quote', inlines: inlines(text) };
  return {
    kind: 'facts',
    facts: parts.map((p) => ({ inlines: inlines(p), tone: BAD_FACT.test(p) ? 'bad' : WARN_FACT.test(p) ? 'warn' : null })),
  };
}

export interface Section {
  readonly blocks: readonly Block[];
  readonly callout: boolean;
}

/** Blocks grouped at each heading (the heading opens its section); a section headed "Next…" is a callout. */
export function markdownSections(blocks: readonly Block[]): Section[] {
  const out: { blocks: Block[]; callout: boolean }[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading' || !out.length) {
      out.push({ blocks: [], callout: b.kind === 'heading' && /^next\b/i.test(plainText(b.inlines).trim()) });
    }
    out[out.length - 1].blocks.push(b);
  }
  return out;
}

/**
 * A table row's cells. A `|` is a cell border except escaped (`\|`, as GitHub Markdown writes it) or inside a mention
 * (`@[call:in:x|POST /a]`) or inline code - so a mention in a table keeps its label instead of splitting the row.
 */
export function cells(line: string): string[] {
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const out: string[] = [];
  let cell = '';
  let mention = 0;
  let code = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '`') code = !code;
    else if (!code && ch === '@' && row[i + 1] === '[') { mention++; cell += '@['; i++; continue; }
    else if (!code && ch === ']' && mention > 0) mention--;
    if (ch === '|' && !mention && !code) { out.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** Mentions first (their labels may hold Markdown characters), then code, links, variables, pills and emphasis in the text between. */
export function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  for (const segment of parseMentions(text)) {
    if ('mention' in segment) out.push({ kind: 'mention', ref: segment.mention });
    else out.push(...formatted(segment.text));
  }
  return out;
}

const TOKEN = new RegExp([
  /(`[^`\n]+`)/.source,                                      // 1 code
  /(\[[^\]\n]+\]\([^)\s]+\))/.source,                         // 2 link
  /(\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|\{(?:red|green|amber|blue|purple)\|[^}\n]+\})/.source, // 3 variable or {red|colour}
  /(\[(?:ok|fail|wait|info)(?::[^\]\n]{1,60})?\](?!\())/.source, // 4 pill
  /(\*\*[^*\n]+\*\*)/.source,                                // 5 bold
  /(__[^_\n]+__)/.source,                                    // 6 bold
  /(==[^=\n]+==)/.source,                                    // 7 highlight
  /(~~[^~\n]+~~)/.source,                                    // 8 strike
  /(\*[^*\n]+\*)/.source,                                    // 9 italic
  /(_[^_\n]+_)/.source,                                      // 10 italic
].join('|'));

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
      if (/^(https?:\/\/|mailto:)/i.test(href) || BOARD_FILE.test(href)) out.push({ kind: 'link', href, children: formatted(label) });
      else out.push({ kind: 'text', text: token });
    } else if (m[3] && token.startsWith('{{')) {
      out.push({ kind: 'variable', name: token.slice(2, -2).trim() });
    } else if (m[3]) {
      const bar = token.indexOf('|');
      out.push({ kind: 'color', color: token.slice(1, bar) as TextColor, children: formatted(token.slice(bar + 1, -1)) });
    } else if (m[4]) {
      out.push(pillOf(token.slice(1, -1)));
    } else if (m[5] || m[6]) {
      out.push({ kind: 'bold', children: formatted(token.slice(2, -2)) });
    } else if (m[7]) {
      out.push({ kind: 'mark', children: formatted(token.slice(2, -2)) });
    } else if (m[8]) {
      out.push({ kind: 'strike', children: formatted(token.slice(2, -2)) });
    } else {
      out.push({ kind: 'italic', children: formatted(token.slice(1, -1)) });
    }
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

/** `ok`, `fail: 500`, ... - the inside of a `[ok]` pill. */
export function pillOf(inner: string): Inline {
  const colon = inner.indexOf(':');
  const tone = (colon < 0 ? inner : inner.slice(0, colon)).trim().toLowerCase() as PillTone;
  const text = colon < 0 ? PILL_LABELS[tone] : inner.slice(colon + 1).trim();
  return { kind: 'pill', tone: PILL_TONES.includes(tone) ? tone : 'info', text: text || PILL_LABELS[tone] };
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
      case 'variable':
        return `{{${n.name}}}`;
      case 'pill':
        return `[${n.text}]`;
      case 'br':
        return '\n';
      default:
        return plainText(n.children);
    }
  }).join('');
}

/** Every heading of the blocks, callouts and folds included - the outline of a long text. */
export function headingsOf(blocks: readonly Block[]): { level: number; slug: string; text: string }[] {
  const out: { level: number; slug: string; text: string }[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') out.push({ level: b.level, slug: b.slug, text: plainText(b.inlines) });
    else if (b.kind === 'callout' || b.kind === 'fold') out.push(...headingsOf(b.blocks));
    else if (b.kind === 'tabs') for (const t of b.tabs) out.push(...headingsOf(t.blocks));
  }
  return out;
}
