import { MentionRef } from '../../core/models/board.models';
import {
  BOARD_FILE, BOARD_IMAGE, Block, CALLOUT_TONES, CALLOUT_TITLES, CalloutTone, Inline, PILL_TONES, PillTone, TEXT_COLORS, TextColor, codeBlock,
  lineBlockOf, markdownBlocks, pillOf, plainText,
} from './markdown-blocks';
import { visualLangOf } from './board-visuals';
import { mentionChipNode } from './mention-dom';
import { parseMentions, serializeMention, slug } from './mention-syntax';

/**
 * Rich text on the board (docs/board.md "Rich text"): the editor's HTML read into the same typed tree as Markdown
 * (markdown-blocks.ts), and that tree written back out - as the HTML that is stored, as the editor's DOM, as Markdown
 * (copy, .md exports) and as plain text. Reading walks an allow-list: a tag outside it gives only its words, and script,
 * style and the like give nothing. The page is never built from the HTML itself - only from the tree (constitution I).
 */

/** HTML starts with one of the editor's block tags; Markdown never does. The backend's RichText.isHtml is the same test. */
const HTML = /^\s*<(p|h[1-4]|ul|ol|div|aside|table|pre|blockquote|details|hr|img|figure|section)[\s>/]/i;

export function isHtml(text: string | null | undefined): boolean {
  return !!text && HTML.test(text);
}

/** Any stored text as the tree: HTML from the editor, else Markdown. */
export function textBlocks(text: string | null | undefined): Block[] {
  return isHtml(text) ? htmlBlocks(text!) : markdownBlocks(text);
}

/** Stored HTML as the tree. DOMParser builds an inert document: nothing in it runs or loads. */
export function htmlBlocks(html: string): Block[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return domBlocks(doc.body);
}

const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'HEAD', 'TITLE', 'META', 'LINK', 'VIDEO', 'AUDIO', 'CANVAS']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'IMG', 'DETAILS',
  'ASIDE', 'FIGURE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'LI', 'DL', 'DT', 'DD', 'CENTER']);

function isBlockNode(n: Node): boolean {
  return n instanceof Element && BLOCK_TAGS.has(n.tagName) && !(n as HTMLElement).dataset?.['mention'];
}

/** The blocks of a container: block elements as blocks, each run of inline content between them one paragraph. */
export function domBlocks(container: Node): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const inl = trimInlines(run.flatMap((n) => domInlines(n)));
    const line = inl.length ? lineBlockOf(inlinesMd(inl).trim()) : null;
    if (line) out.push(line);
    else if (inl.length) out.push({ kind: 'paragraph', inlines: inl });
    run = [];
  };
  container.childNodes.forEach((n) => {
    if (n instanceof Element && DROP.has(n.tagName)) return;
    if (!isBlockNode(n)) {
      run.push(n);
      return;
    }
    flush();
    out.push(...elementBlocks(n as Element));
  });
  flush();
  return out;
}

function elementBlocks(e: Element): Block[] {
  const tag = e.tagName;
  const dataOf = (k: string): string | undefined => (e as HTMLElement).dataset?.[k];
  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const inl = trimInlines(domInlines(e, true));
      return inl.length ? [{ kind: 'heading', level: Math.min(4, Number(tag[1])), slug: slug(plainText(inl)), inlines: inl }] : [];
    }
    case 'HR': return [{ kind: 'rule' }];
    case 'IMG': {
      const src = e.getAttribute('src') ?? '';
      return BOARD_IMAGE.test(src) ? [{ kind: 'image', src, alt: e.getAttribute('alt') ?? '' }] : [];
    }
    case 'PRE': {
      const code = e.querySelector('code');
      const lang = dataOf('lang') ?? (code?.className.match(/language-([\w+#-]+)/)?.[1] ?? '');
      const info = dataOf('info') ?? '';
      const text = (e.textContent ?? '').replace(/\n$/, '');
      const visual = visualLangOf(lang, info);
      return [visual ? { kind: 'visual', lang: visual, info, text } : codeBlock(text, lang)];
    }
    case 'SECTION': {
      if (dataOf('tabs') === undefined) return domBlocks(e);
      // the editor shows each tab's title as an editable <h4 data-tab-title>; its text is the title
      const tabs = Array.from(e.children).filter((c) => c.tagName === 'SECTION').map((c) => {
        const body = c.cloneNode(true) as Element;
        const head = Array.from(body.children).find((x) => x.tagName === 'H4' && (x as HTMLElement).dataset?.['tabTitle'] !== undefined);
        const title = (head?.textContent ?? '').trim() || (c as HTMLElement).dataset?.['tab'] || 'Tab';
        head?.remove();
        return { title, blocks: domBlocks(body) };
      });
      return tabs.length ? [{ kind: 'tabs', tabs }] : [];
    }
    case 'UL': case 'OL': {
      const lis = Array.from(e.children).filter((c) => c.tagName === 'LI');
      const items = lis.map((li) => trimInlines(listItemInlines(li)));
      const checklist = dataOf('checklist') !== undefined || (lis.length > 0 && lis.every((li) => (li as HTMLElement).dataset?.['checked'] !== undefined));
      return checklist
        ? [{ kind: 'list', ordered: tag === 'OL', items, checks: lis.map((li) => (li as HTMLElement).dataset?.['checked'] === 'true') }]
        : [{ kind: 'list', ordered: tag === 'OL', items }];
    }
    case 'BLOCKQUOTE': {
      const inner = domBlocks(e);
      const only = inner.length === 1 && inner[0].kind === 'paragraph' ? inner[0].inlines : null;
      return only ? [{ kind: 'quote', inlines: only }] : [{ kind: 'quote', inlines: trimInlines(domInlines(e, true)) }];
    }
    case 'TABLE': return tableBlock(e);
    case 'DETAILS': {
      const summary = Array.from(e.children).find((c) => c.tagName === 'SUMMARY');
      const body = e.cloneNode(true) as Element;
      Array.from(body.children).filter((c) => c.tagName === 'SUMMARY').forEach((c) => c.remove());
      return [{ kind: 'fold', summary: summary ? trimInlines(domInlines(summary)) : [{ kind: 'text', text: 'Details' }], blocks: domBlocks(body) }];
    }
    case 'ASIDE': {
      const tone = (CALLOUT_TONES as readonly string[]).includes(dataOf('callout') ?? '') ? dataOf('callout') as CalloutTone : 'info';
      // the first bold line is the title - as the editor writes it
      const body = e.cloneNode(true) as Element;
      let title: Inline[] = [];
      const first = body.firstElementChild;
      if (first && (first.tagName === 'B' || first.tagName === 'STRONG') && body.firstChild === first) {
        title = trimInlines(Array.from(first.childNodes).flatMap((n) => domInlines(n))); // its words - the <b> is the title's own
        first.remove();
      }
      return [{ kind: 'callout', tone, title, blocks: domBlocks(body) }];
    }
    case 'LI': return [{ kind: 'paragraph', inlines: trimInlines(listItemInlines(e)) }];
    default: return domBlocks(e); // a div, a section...: its content
  }
}

/** A list item's words - a nested list or paragraph inside it joins on one line (the board's lists are one level). */
function listItemInlines(li: Element): Inline[] {
  const out: Inline[] = [];
  li.childNodes.forEach((n) => {
    if (n instanceof Element && (n.tagName === 'UL' || n.tagName === 'OL')) {
      Array.from(n.children).forEach((c) => { out.push({ kind: 'text', text: ' · ' }, ...domInlines(c, true)); });
    } else {
      out.push(...domInlines(n, true));
    }
  });
  return out;
}

function tableBlock(e: Element): Block[] {
  const rows = Array.from(e.querySelectorAll('tr')).filter((tr) => tr.closest('table') === e);
  if (!rows.length) return [];
  const cellsOf = (tr: Element): Inline[][] => Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    .map((c) => trimInlines(domInlines(c, true)));
  const [first, ...rest] = rows;
  return [{ kind: 'table', header: cellsOf(first), rows: rest.map(cellsOf) }];
}

/** Inline content of a node. {@code flatBlocks}: block elements inside give their words, a line break between. */
export function domInlines(n: Node, flatBlocks = false): Inline[] {
  if (n.nodeType === Node.TEXT_NODE) return textInlines(n.nodeValue ?? '');
  if (!(n instanceof Element) || DROP.has(n.tagName)) return [];
  const el = n as HTMLElement;
  const kids = (): Inline[] => Array.from(n.childNodes).flatMap((c) => domInlines(c, flatBlocks));
  const mention = el.dataset?.['mention'];
  if (mention) {
    const seg = parseMentions(mention)[0];
    return seg && 'mention' in seg ? [{ kind: 'mention', ref: seg.mention }] : textInlines(el.textContent ?? '');
  }
  const variable = el.dataset?.['var'];
  if (variable) return [{ kind: 'variable', name: variable }];
  const pill = el.dataset?.['pill'];
  if (pill !== undefined && n.tagName === 'SPAN') {
    const tone: PillTone = (PILL_TONES as readonly string[]).includes(pill) ? pill as PillTone : 'info';
    return [{ kind: 'pill', tone, text: (el.textContent ?? '').trim() || tone }];
  }
  switch (n.tagName) {
    case 'BR': return el.dataset?.['filler'] ? [] : [{ kind: 'br' }];
    case 'B': case 'STRONG': return wrap('bold', kids());
    case 'I': case 'EM': return wrap('italic', kids());
    case 'U': case 'INS': return wrap('underline', kids());
    case 'S': case 'STRIKE': case 'DEL': return wrap('strike', kids());
    case 'MARK': return wrap('mark', kids());
    case 'SUB': return wrap('sub', kids());
    case 'SUP': return wrap('sup', kids());
    case 'KBD': return wrap('kbd', kids());
    case 'CODE': return [{ kind: 'code', text: el.textContent ?? '' }];
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      return /^(https?:\/\/|mailto:)/i.test(href) || BOARD_FILE.test(href) ? [{ kind: 'link', href, children: kids() }] : kids();
    }
    case 'SPAN': case 'FONT': {
      const color = colorOf(el);
      return color ? [{ kind: 'color', color, children: kids() }] : kids();
    }
    case 'IMG': return [];
    case 'INPUT': return [];
    default:
      if (BLOCK_TAGS.has(n.tagName)) {
        const inner = kids();
        return flatBlocks && inner.length ? [...inner, { kind: 'br' }] : inner;
      }
      return kids();
  }
}

function wrap(kind: 'bold' | 'italic' | 'underline' | 'strike' | 'mark' | 'sub' | 'sup' | 'kbd', children: Inline[]): Inline[] {
  return children.length ? [{ kind, children }] : [];
}

/** A colour the board knows - from the editor's data-color, or the nearest of a pasted style colour. */
function colorOf(el: HTMLElement): TextColor | null {
  const data = el.dataset?.['color'];
  if (data && (TEXT_COLORS as readonly string[]).includes(data)) return data as TextColor;
  const style = (el.getAttribute('style') ?? '') + ' ' + (el.getAttribute('color') ?? '');
  const m = /color\s*:\s*([^;]+)|^\s*(#[0-9a-f]{3,6}|[a-z]+)\s*$/i.exec(style.trim());
  const c = (m?.[1] ?? m?.[2] ?? '').trim().toLowerCase();
  if (!c) return null;
  if (/red|#(?:c|d|e|f)[0-4]|crimson|#f87171|#ef4444|#dc2626/.test(c)) return 'red';
  if (/green|#[0-4][8-f][0-6]|#34d399|#22c55e|#16a34a/.test(c)) return 'green';
  if (/orange|amber|yellow|gold|#f59e0b|#fbbf24|#eab308/.test(c)) return 'amber';
  if (/blue|#[0-4][0-9a-f][a-f]|#60a5fa|#3b82f6|#2563eb/.test(c)) return 'blue';
  if (/purple|violet|#8b5cf6|#a855f7/.test(c)) return 'purple';
  return null;
}

/** Text with mentions, `{{variables}}` and `[ok]` pills - nothing else is read from the words of HTML. */
export function textInlines(text: string): Inline[] {
  const out: Inline[] = [];
  for (const seg of parseMentions(text)) {
    if ('mention' in seg) {
      out.push({ kind: 'mention', ref: seg.mention });
      continue;
    }
    let rest = seg.text;
    const re = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|\[((?:ok|fail|wait|info)(?::[^\]\n]{1,60})?)\](?!\()/;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      if (m.index > 0) out.push(...lines(rest.slice(0, m.index)));
      out.push(m[1] ? { kind: 'variable', name: m[1] } : pillOf(m[2]));
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push(...lines(rest));
  }
  return out;
}

/** A "\n" in the editor's text is a line break. */
function lines(text: string): Inline[] {
  const parts = text.split('\n');
  return parts.flatMap((p, i) => (i === 0 ? (p ? [{ kind: 'text' as const, text: p }] : []) : [{ kind: 'br' as const }, ...(p ? [{ kind: 'text' as const, text: p }] : [])]));
}

/** No line breaks or blank text at the ends of a paragraph. */
function trimInlines(nodes: Inline[]): Inline[] {
  const out = [...nodes];
  while (out.length && (out[0].kind === 'br' || (out[0].kind === 'text' && !out[0].text.trim()))) out.shift();
  while (out.length && (out[out.length - 1].kind === 'br' || (out[out.length - 1].kind === 'text' && !(out[out.length - 1] as { text: string }).text.trim()))) out.pop();
  return out;
}

// ------------------------------------------------------------------------------------------------------- writing out

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

/** The tree as the HTML that is stored: only the board's tags, every text escaped, mentions as their `@[...]`. */
export function blocksToHtml(blocks: readonly Block[]): string {
  return blocks.map(blockHtml).join('');
}

function blockHtml(b: Block): string {
  switch (b.kind) {
    case 'heading': return `<h${b.level}>${inlinesHtml(b.inlines)}</h${b.level}>`;
    case 'paragraph': return `<p>${inlinesHtml(b.inlines)}</p>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map((it, i) => (b.checks ? `<li data-checked="${b.checks[i] ? 'true' : 'false'}">` : '<li>') + inlinesHtml(it) + '</li>').join('');
      return `<${tag}${b.checks ? ' data-checklist=""' : ''}>${items}</${tag}>`;
    }
    case 'code': return `<pre${b.lang ? ` data-lang="${escAttr(b.lang)}"` : ''}>${esc(b.text)}</pre>`;
    case 'quote': return `<blockquote>${inlinesHtml(b.inlines)}</blockquote>`;
    case 'facts': return `<blockquote>${b.facts.map((f) => inlinesHtml(f.inlines)).join(' · ')}</blockquote>`;
    case 'table': return `<table><thead><tr>${b.header.map((c) => `<th>${inlinesHtml(c)}</th>`).join('')}</tr></thead><tbody>${
      b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlinesHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'rule': return '<hr>';
    case 'callout': return `<aside data-callout="${b.tone}">${b.title.length ? `<b>${inlinesHtml(b.title)}</b>` : ''}${blocksToHtml(b.blocks)}</aside>`;
    case 'fold': return `<details><summary>${inlinesHtml(b.summary)}</summary>${blocksToHtml(b.blocks)}</details>`;
    case 'image': return `<img src="${escAttr(b.src)}" alt="${escAttr(b.alt)}">`;
    case 'visual': return `<pre data-lang="${escAttr(b.lang)}"${b.info ? ` data-info="${escAttr(b.info)}"` : ''}>${esc(b.text)}</pre>`;
    case 'tabs': return `<section data-tabs="">${b.tabs.map((t) => `<section data-tab="${escAttr(t.title)}">${blocksToHtml(t.blocks)}</section>`).join('')}</section>`;
    case 'progress': case 'choices': case 'actions': case 'callview': case 'widget': return `<p>${esc(blockMd(b))}</p>`;
  }
}

function inlinesHtml(nodes: readonly Inline[]): string {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return esc(n.text);
      case 'code': return `<code>${esc(n.text)}</code>`;
      case 'bold': return `<b>${inlinesHtml(n.children)}</b>`;
      case 'italic': return `<i>${inlinesHtml(n.children)}</i>`;
      case 'underline': return `<u>${inlinesHtml(n.children)}</u>`;
      case 'strike': return `<s>${inlinesHtml(n.children)}</s>`;
      case 'mark': return `<mark>${inlinesHtml(n.children)}</mark>`;
      case 'sub': return `<sub>${inlinesHtml(n.children)}</sub>`;
      case 'sup': return `<sup>${inlinesHtml(n.children)}</sup>`;
      case 'kbd': return `<kbd>${inlinesHtml(n.children)}</kbd>`;
      case 'color': return `<span data-color="${n.color}">${inlinesHtml(n.children)}</span>`;
      case 'link': return `<a href="${escAttr(n.href)}">${inlinesHtml(n.children)}</a>`;
      case 'mention': return esc(serializeMention(n.ref));
      case 'variable': return esc(`{{${n.name}}}`);
      case 'pill': return `<span data-pill="${n.tone}">${esc(n.text)}</span>`;
      case 'br': return '<br>';
    }
  }).join('');
}

/** The tree as the editor's DOM - mentions and variables as atomic pills. Built with createElement only. */
export function blocksToDom(blocks: readonly Block[], doc: Document): Node[] {
  return blocks.map((b) => blockDom(b, doc));
}

function el(doc: Document, tag: string, children: Node[] = [], attrs: Record<string, string> = {}): HTMLElement {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function blockDom(b: Block, doc: Document): Node {
  switch (b.kind) {
    case 'heading': return el(doc, `h${b.level}`, inlinesDom(b.inlines, doc));
    case 'paragraph': return el(doc, 'p', inlineBlockDom(b.inlines, doc));
    case 'list': return el(doc, b.ordered ? 'ol' : 'ul', b.items.map((it, i) => el(doc, 'li', inlineBlockDom(it, doc),
      b.checks ? { 'data-checked': b.checks[i] ? 'true' : 'false' } : {})), b.checks ? { 'data-checklist': '' } : {});
    case 'code': return el(doc, 'pre', [doc.createTextNode(b.text)], b.lang ? { 'data-lang': b.lang } : {});
    case 'quote': return el(doc, 'blockquote', inlineBlockDom(b.inlines, doc));
    case 'facts': return el(doc, 'blockquote', inlinesDom(b.facts.flatMap((f, i) => (i ? [{ kind: 'text', text: ' · ' } as Inline, ...f.inlines] : f.inlines)), doc));
    case 'table': return el(doc, 'table', [
      el(doc, 'thead', [el(doc, 'tr', b.header.map((c) => el(doc, 'th', inlineBlockDom(c, doc))))]),
      el(doc, 'tbody', b.rows.map((r) => el(doc, 'tr', r.map((c) => el(doc, 'td', inlineBlockDom(c, doc)))))),
    ]);
    case 'rule': return el(doc, 'hr');
    case 'callout': return el(doc, 'aside', [...(b.title.length ? [el(doc, 'b', inlinesDom(b.title, doc))] : []),
      ...(b.blocks.length ? blocksToDom(b.blocks, doc) : [el(doc, 'p', [el(doc, 'br')])])], { 'data-callout': b.tone });
    case 'fold': return el(doc, 'details', [el(doc, 'summary', inlinesDom(b.summary, doc)),
      ...(b.blocks.length ? blocksToDom(b.blocks, doc) : [el(doc, 'p', [el(doc, 'br')])])], { open: '' });
    case 'image': return el(doc, 'img', [], { src: b.src, alt: b.alt });
    case 'visual': return el(doc, 'pre', [doc.createTextNode(b.text)], { 'data-lang': b.lang, ...(b.info ? { 'data-info': b.info } : {}) });
    case 'tabs': return el(doc, 'section', b.tabs.map((t) => el(doc, 'section', [
      el(doc, 'h4', [doc.createTextNode(t.title)], { 'data-tab-title': '' }),
      ...(t.blocks.length ? blocksToDom(t.blocks, doc) : [el(doc, 'p', [el(doc, 'br')])])], { 'data-tab': t.title })), { 'data-tabs': '' });
    case 'progress': case 'choices': case 'actions': case 'callview': case 'widget': return el(doc, 'p', [doc.createTextNode(blockMd(b))]);
  }
}

/** An empty block still needs a <br> to be clickable in a contenteditable. */
function inlineBlockDom(nodes: readonly Inline[], doc: Document): Node[] {
  const out = inlinesDom(nodes, doc);
  return out.length ? out : [el(doc, 'br')];
}

export function inlinesDom(nodes: readonly Inline[], doc: Document): Node[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return doc.createTextNode(n.text);
      case 'code': return el(doc, 'code', [doc.createTextNode(n.text)]);
      case 'bold': return el(doc, 'b', inlinesDom(n.children, doc));
      case 'italic': return el(doc, 'i', inlinesDom(n.children, doc));
      case 'underline': return el(doc, 'u', inlinesDom(n.children, doc));
      case 'strike': return el(doc, 's', inlinesDom(n.children, doc));
      case 'mark': return el(doc, 'mark', inlinesDom(n.children, doc));
      case 'sub': return el(doc, 'sub', inlinesDom(n.children, doc));
      case 'sup': return el(doc, 'sup', inlinesDom(n.children, doc));
      case 'kbd': return el(doc, 'kbd', inlinesDom(n.children, doc));
      case 'color': return el(doc, 'span', inlinesDom(n.children, doc), { 'data-color': n.color });
      case 'link': return el(doc, 'a', inlinesDom(n.children, doc), { href: n.href });
      case 'mention': return mentionChipNode(doc, n.ref);
      case 'variable': return variablePillNode(doc, n.name);
      case 'pill': return el(doc, 'span', [doc.createTextNode(n.text)], { 'data-pill': n.tone });
      case 'br': return el(doc, 'br');
    }
  });
}

/** A `{{name}}` pill in the editor: atomic, stored as the name only - never its value. */
export function variablePillNode(doc: Document, name: string): HTMLElement {
  const pill = el(doc, 'span', [doc.createTextNode(`{{${name}}}`)], { 'data-var': name, contenteditable: 'false', class: 'board-var-pill' });
  pill.title = `Global variable ${name} - shows its value in the active environment`;
  return pill;
}

/** The tree as Markdown - copy as Markdown and the .md exports. */
export function blocksToMarkdown(blocks: readonly Block[]): string {
  return blocks.map(blockMd).filter((s) => s !== '').join('\n\n');
}

function blockMd(b: Block): string {
  switch (b.kind) {
    case 'heading': return `${'#'.repeat(b.level)} ${inlinesMd(b.inlines)}`;
    case 'paragraph': return inlinesMd(b.inlines);
    case 'list': return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${b.checks ? (b.checks[i] ? '[x] ' : '[ ] ') : ''}${inlinesMd(it)}`).join('\n');
    case 'code': return '```' + b.lang + '\n' + b.text + '\n```';
    case 'quote': return inlinesMd(b.inlines).split('\n').map((l) => `> ${l}`).join('\n');
    case 'facts': return `> ${b.facts.map((f) => inlinesMd(f.inlines)).join(' · ')}`;
    case 'table': {
      const row = (r: readonly (readonly Inline[])[]): string => `| ${r.map((c) => inlinesMd(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
      return [row(b.header), `| ${b.header.map(() => '---').join(' | ')} |`, ...b.rows.map(row)].join('\n');
    }
    case 'rule': return '---';
    case 'callout': {
      const head = `> [!${b.tone === 'warn' ? 'WARNING' : b.tone.toUpperCase()}]${b.title.length ? ' ' + inlinesMd(b.title) : ''}`;
      const body = blocksToMarkdown(b.blocks);
      return [head, ...(body ? body.split('\n').map((l) => `> ${l}`) : [])].join('\n');
    }
    case 'fold': return `+++ ${inlinesMd(b.summary)}\n${blocksToMarkdown(b.blocks)}\n+++`;
    case 'image': return `![${b.alt}](${b.src})`;
    case 'visual': return '```' + b.lang + (b.info ? ' ' + b.info : '') + '\n' + b.text + '\n```';
    case 'tabs': return [':::tabs', ...b.tabs.map((t) => `## ${t.title}\n${blocksToMarkdown(t.blocks)}`), ':::'].join('\n');
    case 'progress': return `[progress: ${b.value}/${b.max}${b.label ? ' ' + b.label : ''}]`;
    case 'choices': return `[choose: ${b.options.join(' | ')}]`;
    case 'actions': return b.items.map((a) => `[action: ${a.kind}${a.arg ? ' ' + a.arg : ''}${a.label && a.label !== (a.kind + (a.arg ? ' ' + a.arg : '')) ? ' | ' + a.label : ''}]`).join(' ');
    case 'callview': return '!' + serializeMention(b.ref);
    case 'widget': return `{{widget:${b.name}${b.args ? ' | ' + b.args : ''}}}`;
  }
}

export function inlinesMd(nodes: readonly Inline[]): string {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'code': return '`' + n.text + '`';
      case 'bold': return `**${inlinesMd(n.children)}**`;
      case 'italic': return `*${inlinesMd(n.children)}*`;
      case 'underline': return inlinesMd(n.children);
      case 'strike': return `~~${inlinesMd(n.children)}~~`;
      case 'mark': return `==${inlinesMd(n.children)}==`;
      case 'sub': return inlinesMd(n.children);
      case 'sup': return inlinesMd(n.children);
      case 'kbd': return '`' + inlinesMd(n.children) + '`';
      case 'color': return `{${n.color}|${inlinesMd(n.children)}}`;
      case 'link': return `[${inlinesMd(n.children)}](${n.href})`;
      case 'mention': return serializeMention(n.ref);
      case 'variable': return `{{${n.name}}}`;
      case 'pill': return `[${n.tone}${n.text && n.text !== n.tone ? `: ${n.text}` : ''}]`;
      case 'br': return '\n';
    }
  }).join('');
}

/** Any stored text as Markdown - HTML converted, Markdown as it is. */
export function textAsMarkdown(text: string | null | undefined): string {
  return isHtml(text) ? blocksToMarkdown(htmlBlocks(text!)) : text ?? '';
}

/** The plain words of a text: mentions as their labels, variables as {{name}}. */
export function textAsPlain(text: string | null | undefined): string {
  return blocksToPlain(textBlocks(text));
}

export function blocksToPlain(blocks: readonly Block[]): string {
  return blocks.map((b): string => {
    switch (b.kind) {
      case 'heading': case 'paragraph': case 'quote': return plainText(b.inlines);
      case 'list': return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${b.checks ? (b.checks[i] ? '[x] ' : '[ ] ') : ''}${plainText(it)}`).join('\n');
      case 'code': return b.text;
      case 'facts': return b.facts.map((f) => plainText(f.inlines)).join(' · ');
      case 'table': return [b.header, ...b.rows].map((r) => r.map(plainText).join('\t')).join('\n');
      case 'rule': return '---';
      case 'callout': return [CALLOUT_TITLES[b.tone] + (b.title.length ? `: ${plainText(b.title)}` : ''), blocksToPlain(b.blocks)].join('\n');
      case 'fold': return [plainText(b.summary), blocksToPlain(b.blocks)].join('\n');
      case 'image': return `[picture${b.alt ? `: ${b.alt}` : ''}]`;
      case 'visual': return b.text;
      case 'tabs': return b.tabs.map((t) => `${t.title}\n${blocksToPlain(t.blocks)}`).join('\n\n');
      case 'progress': return `${b.value}/${b.max}${b.label ? ' ' + b.label : ''}`;
      case 'choices': return b.options.join(' / ');
      case 'actions': return b.items.map((a) => a.label).join(' · ');
      case 'callview': return b.ref.label;
      case 'widget': return `[widget ${b.name}]`;
    }
  }).filter(Boolean).join('\n\n');
}

/** Whether a Markdown text uses anything beyond plain paragraphs - the editor then opens it as rich text. */
export function hasFormatting(text: string | null | undefined): boolean {
  if (isHtml(text)) return true;
  return markdownBlocks(text).some((b) => b.kind !== 'paragraph' || b.inlines.some((i) => i.kind !== 'text' && i.kind !== 'mention'));
}

/** Every mention of a tree, in order (the editor's call list). */
export function mentionsOfBlocks(blocks: readonly Block[]): MentionRef[] {
  const out: MentionRef[] = [];
  const walk = (nodes: readonly Inline[]): void => nodes.forEach((n) => (n.kind === 'mention' ? out.push(n.ref) : 'children' in n ? walk(n.children) : undefined));
  const blk = (bs: readonly Block[]): void => bs.forEach((b) => {
    if ('inlines' in b) walk(b.inlines);
    if (b.kind === 'list') b.items.forEach(walk);
    if (b.kind === 'table') [b.header, ...b.rows].forEach((r) => r.forEach(walk));
    if (b.kind === 'callout') { walk(b.title); blk(b.blocks); }
    if (b.kind === 'fold') { walk(b.summary); blk(b.blocks); }
    if (b.kind === 'facts') b.facts.forEach((f) => walk(f.inlines));
    if (b.kind === 'tabs') b.tabs.forEach((t) => blk(t.blocks));
    if (b.kind === 'callview') out.push(b.ref);
  });
  blk(blocks);
  return out;
}
