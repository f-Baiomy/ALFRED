import { blocksToMarkdown, htmlBlocks } from './frontend.ts';

/**
 * What Claude writes on the board may be Markdown, HTML, or both in one text (docs/board.md "Visuals and snippets").
 * The board stores and shows board Markdown - Claude's comments are stored as `**Reply** …` / `**Did** …`, which the
 * board reads as Markdown, and it never shows raw HTML in Markdown as markup (that would let a text inject a page).
 * So every text is made board text here, before it is sent:
 *
 * - Markdown stays exactly as written (fenced code, ```stats, ```html live … untouched).
 * - An HTML part the board can draw itself (p, headings, lists, table, blockquote, details, aside callouts, colour spans,
 *   pills, links, images…) becomes the same board Markdown the editor's HTML is read as (rich-html.ts) - a table is a
 *   table, `<span style="color:green">` the nearest board colour. Nothing the board can show is lost.
 * - An HTML part that needs a page to run - a script, a style sheet, SVG, a canvas, a form control, an iframe - becomes a
 *   ```` ```html live ```` snippet, kept byte for byte and run in the locked frame.
 * - Inline tags in a Markdown line (`<b>`, `<span data-color="red">`, `<br>`…) become their Markdown.
 */
export interface BoardText {
  readonly text: string;
  /** HTML parts turned into ```html live snippets - worth a board_snippet_view before calling the work done. */
  readonly snippets: number;
}

/** A line that starts an HTML part: a tag (not `<https://…>`, not `<-` arrows) or an HTML comment. */
const HTML_LINE = /^\s*<(?:!--|\/?[a-zA-Z][\w-]*(?:[\s/>]|$))/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/** Tags the board cannot draw itself: the part runs as a snippet. */
const NEEDS_FRAME = new RegExp('<(?:script|style|svg|canvas|iframe|button|input|select|textarea|form|video|audio|object|embed|math|link|meta)\\b'
  // motion in a style attribute: the board's own text drops style, so only the frame keeps it moving
  + '|\\sstyle\\s*=\\s*("[^"]*|\'[^\']*)\\b(?:animation|transition|transform)\\b', 'i');
const INLINE_TAG = /<\/?(?:b|strong|i|em|u|s|del|strike|mark|sub|sup|kbd|code|span|font|a|br|small)\b[^>]*>/i;
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'source', 'wbr', 'embed', 'param', 'track']);

export function boardText(text: string): BoardText {
  if (!/</.test(text)) return { text, snippets: 0 };
  const lines = text.split('\n');
  const out: string[] = [];
  let snippets = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = open[1];
      out.push(line);
      continue;
    }
    if (HTML_LINE.test(line)) {
      // HTML elements one after another (blank lines between them too) are one part: a <style>, a <div> and the <script>
      // that fills it run together.
      let j = partEnd(lines, i);
      for (let k = j + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') continue;
        if (!HTML_LINE.test(lines[k])) break;
        j = k = partEnd(lines, k);
      }
      const part = lines.slice(i, j + 1).join('\n').trim();
      if (NEEDS_FRAME.test(part)) {
        block(out, snippetFence(part));
        snippets++;
      } else {
        block(out, asMarkdown(part));
      }
      i = j;
      if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
      continue;
    }
    out.push(INLINE_TAG.test(line) ? inlineLine(line) : line);
  }
  return { text: out.join('\n'), snippets };
}

/** Every board text field of a request made board text; the count of snippets made. */
export function boardTexts<T extends Record<string, unknown>>(body: T, keys: readonly (keyof T)[]): { body: T; snippets: number } {
  let snippets = 0;
  const next: Record<string, unknown> = { ...body };
  for (const k of keys) {
    const v = body[k];
    if (typeof v !== 'string') continue;
    const t = boardText(v);
    next[k as string] = t.text;
    snippets += t.snippets;
  }
  return { body: next as T, snippets };
}

/** What a reply adds when HTML became a snippet. */
export function snippetNote(snippets: number): Record<string, string> {
  return snippets ? { snippets: `${snippets} HTML part${snippets === 1 ? '' : 's'} with script/style/SVG became \`\`\`html live snippets `
    + '(the locked frame, no network) - check what they drew with board_snippet_view.' } : {};
}

/** The last line of the HTML element(s) starting at line i: where its tags close at a line's end, else the next blank line. */
function partEnd(lines: readonly string[], i: number): number {
  let j = i;
  while (j < lines.length - 1 && depth(lines.slice(i, j + 1).join('\n')) > 0) j++;
  if (depth(lines.slice(i, j + 1).join('\n')) <= 0) return j;
  j = i;
  while (j < lines.length - 1 && lines[j + 1].trim() !== '') j++;
  return j;
}

/** A converted part is its own Markdown block: a blank line before it, or a table would swallow the line above. */
function block(out: string[], md: string): void {
  if (out.length && out[out.length - 1].trim() !== '') out.push('');
  out.push(md);
}

function asMarkdown(html: string): string {
  // A table cell escapes `|`; a mention's own `|` needs no escape there (the table reader skips mentions), and the
  // backend's mention index reads the text as written - `@[call:in:x\|…]` would index the ref `in:x\`.
  return blocksToMarkdown(htmlBlocks(html.trim())).replace(/(@\[[a-z]+:[^|\]\n]*?)\\\|/g, '$1|');
}

/** A Markdown line with inline tags: the tags read as the board reads pasted HTML, `code spans` left alone. */
function inlineLine(line: string): string {
  const codes: string[] = [];
  const masked = line.replace(/`[^`]*`/g, (c) => `${codes.push(c) - 1}`);
  if (!INLINE_TAG.test(masked)) return line;
  const lead = /^\s*(?:[-*+] (?:\[[ xX]\] )?|\d+\. |#{1,6} |> ?)?/.exec(masked)![0];
  const md = asMarkdown(`<p>${masked.slice(lead.length)}</p>`).replace(/\n+/g, ' ');
  return lead + md.replace(/(\d+)/g, (_, n: string) => codes[Number(n)]);
}

function snippetFence(html: string): string {
  const ticks = '`'.repeat(Math.max(3, ...[...html.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return `${ticks}html live\n${html.trim()}\n${ticks}`;
}

/** How many elements are still open at the end of an HTML part. A script or style body is skipped whole. */
function depth(html: string): number {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  if (/<!--|<(?:script|style)\b/i.test(body)) return 1;
  let d = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3]) continue;
    d += m[1] ? -1 : 1;
  }
  return d;
}
