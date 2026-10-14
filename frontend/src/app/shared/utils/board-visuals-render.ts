import { Block } from './markdown-blocks';
import { infoAttrs } from './board-visuals';
import { BoardVisuals, ExportedPage, ExportedShot, stateAnswers } from './board-visuals-export';
import { escapeHtml } from './html-builder';
import { blocksToHtml, textBlocks } from './rich-html';
import { buildSnippetDoc, declaredData, staticAnswerKey } from './snippet-frame';

/**
 * The visuals in the board's .md and .html exports (specs/017 R35, R43). Nothing is shortened: every page's source is
 * written whole. The .md shows each snippet's newest picture as an embedded PNG; the .html runs each snippet in the
 * same locked frame the board uses, offline - its libraries inside, its saved values, files and declared data answered
 * from what was captured at export time - with the picture beside it.
 */

/** A snippet in a text, in the order the board numbers them (MarkdownViewComponent.snippetOrder). */
export function textSnippets(text: string | null | undefined): Extract<Block, { kind: 'visual' }>[] {
  const out: Extract<Block, { kind: 'visual' }>[] = [];
  const walk = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'visual' && (b.lang === 'html' || b.lang === 'mermaid' || b.lang === 'python')) out.push(b);
      else if (b.kind === 'tabs') for (const t of b.tabs) walk(t.blocks);
      else if (b.kind === 'callout' || b.kind === 'fold') walk(b.blocks);
    }
  };
  walk(textBlocks(text ?? ''));
  return out;
}

/** Everything an export needs to run frames: the shelf code by file, and the Alfred the export came from. */
export interface FrameKit {
  readonly origin: string;
  readonly libCode: Readonly<Record<string, string>>;
  /** Answers for declared `alfred/data` blocks, read at export time, by staticAnswerKey. */
  readonly data: Readonly<Record<string, unknown>>;
}

const LANG: Record<string, string> = { HTML: 'html', MERMAID: 'mermaid', PYTHON: 'python', BLOCK: 'markdown' };

function shotOf(v: BoardVisuals, snippetId: string): ExportedShot | undefined {
  return v.shots.find((s) => s.snippetId === snippetId);
}

function fence(lang: string, text: string): string[] {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return [ticks + lang, text, ticks];
}

// ------------------------------------------------------------------------------------------------------------- .md

/** A card's (or cycle's, or the project's) pages and its inline snippets' pictures, as Markdown lines. */
export function visualsMd(v: BoardVisuals, pages: readonly ExportedPage[], inline: readonly { label: string; snippetId: string }[]): string[] {
  const lines: string[] = [];
  if (pages.length) {
    lines.push('### Pages', '');
    for (const p of pages) {
      const pg = p.page;
      lines.push(`#### ${pg.pinned ? '📌 ' : ''}${pg.name} (${pg.kind.toLowerCase()}, v${pg.version}, by ${pg.author === 'CLAUDE' ? 'Claude' : 'User'})`, '');
      if (pg.info) lines.push(`Settings: \`${pg.info}\``, '');
      lines.push(...fence(LANG[pg.kind] ?? 'text', pg.source ?? ''), '');
      const shot = shotOf(v, `page:${pg.id}`);
      if (shot) lines.push(`![${pg.name} - as drawn, v${shot.version}](data:image/png;base64,${shot.png})`, '');
      if (p.versions.length > 1) lines.push(`_${p.versions.length} versions; older ones are in the .json export._`, '');
    }
  }
  const drawn = inline.map((i) => ({ ...i, shot: shotOf(v, i.snippetId) })).filter((i) => i.shot);
  if (drawn.length) {
    lines.push('### Snippets as drawn', '');
    for (const i of drawn) lines.push(`${i.label}:`, '', `![${i.label}](data:image/png;base64,${i.shot!.png})`, '');
  }
  return lines;
}

export function filesMd(v: BoardVisuals, where: (f: BoardVisuals['files'][number]) => boolean): string[] {
  const mine = v.files.filter(where);
  if (!mine.length) return [];
  return ['### Files', '', ...mine.map((f) => `- 📎 ${f.name} · ${f.mime} · ${f.size} bytes · by ${f.author === 'CLAUDE' ? 'Claude' : 'User'} · ${f.createdAt}`), ''];
}

export function widgetsMd(v: BoardVisuals): string[] {
  if (!v.widgets.length) return [];
  const lines = ['## Widgets', '', 'Used in a text as `{{widget:name | key=value}}`.', ''];
  for (const w of v.widgets) lines.push(`### ★ ${w.name} (${w.kind.toLowerCase()})`, '', ...fence(LANG[w.kind] ?? 'text', w.source ?? ''), '');
  return lines;
}

// ----------------------------------------------------------------------------------------------------------- .html

function frameHtml(kit: FrameKit, v: BoardVisuals, o: { source: string; info: string; kind: 'html' | 'mermaid'; snippetId: string; name: string }): string {
  const attrs = infoAttrs(o.info);
  const answers: Record<string, unknown> = { ...stateAnswers(v.states, o.snippetId, staticAnswerKey) };
  for (const d of declaredData(o.source)) {
    const key = staticAnswerKey('data', { src: d.src, args: d.args });
    if (key in kit.data) answers[key] = kit.data[key];
  }
  const doc = buildSnippetDoc({ source: o.source, kind: o.kind, libs: attrs['libs'], origin: kit.origin, name: o.name, inline: kit.libCode,
    staticAnswers: answers, offline: true });
  const height = Math.min(900, Math.max(120, Number(attrs['height']) || 360));
  return `<iframe class="snip" sandbox="allow-scripts" title="${escapeHtml(o.name)}" style="height:${height}px" srcdoc="${escapeHtml(doc).replace(/"/g, '&quot;')}"></iframe>`;
}

function shotHtml(shot: ExportedShot | undefined, label: string): string {
  return shot ? `<details><summary class="dim">As drawn in Alfred (v${shot.version}, ${escapeHtml(shot.at)})</summary>`
    + `<img class="shot" alt="${escapeHtml(label)}" src="data:image/png;base64,${shot.png}"></details>` : '';
}

/** One snippet as the export page shows it: running offline (Python: its picture), its source folded below. */
export function snippetHtml(kit: FrameKit, v: BoardVisuals, o: { source: string; info: string; lang: string; snippetId: string; name: string }): string {
  const shot = shotOf(v, o.snippetId);
  const run = o.lang === 'python'
    ? (shot ? `<img class="shot" alt="${escapeHtml(o.name)}" src="data:image/png;base64,${shot.png}">` : '<p class="dim">Python runs only inside Alfred - not drawn yet.</p>')
    : frameHtml(kit, v, { source: o.source, info: o.info, kind: o.lang === 'mermaid' ? 'mermaid' : 'html', snippetId: o.snippetId, name: o.name });
  return `<div class="vis"><div class="vis-h">${o.lang === 'mermaid' ? '⬡' : o.lang === 'python' ? '🐍' : '◈'} ${escapeHtml(o.name)}</div>${run}`
    + (o.lang === 'python' ? '' : shotHtml(shot, o.name))
    + `<details><summary class="dim">Source</summary><pre>${escapeHtml(o.source)}</pre></details></div>`;
}

export function pagesHtml(kit: FrameKit, v: BoardVisuals, pages: readonly ExportedPage[]): string {
  if (!pages.length) return '';
  return '<h3>Pages</h3>' + pages.map((p) => {
    const pg = p.page;
    const name = `${pg.pinned ? '📌 ' : ''}${pg.name} · v${pg.version}`;
    if (pg.kind === 'BLOCK') {
      return `<div class="vis"><div class="vis-h">▤ ${escapeHtml(name)}</div><div class="t r">${blocksToHtml(textBlocks(pg.source ?? ''))}</div></div>`;
    }
    return snippetHtml(kit, v, { source: pg.source ?? '', info: pg.info, lang: LANG[pg.kind] ?? 'html', snippetId: `page:${pg.id}`, name });
  }).join('');
}

/** A text's snippets running offline, after the text itself (which keeps them as source). */
export function inlineHtml(kit: FrameKit, v: BoardVisuals, text: string | null | undefined, idPrefix: string, label: string): string {
  const snippets = textSnippets(text);
  if (!snippets.length) return '';
  return snippets.map((b, n) => snippetHtml(kit, v, { source: b.text, info: b.info, lang: b.lang, snippetId: `${idPrefix}:${n}`,
    name: infoAttrs(b.info)['name'] || `${label} snippet ${n + 1}` })).join('');
}

export function filesHtml(v: BoardVisuals, where: (f: BoardVisuals['files'][number]) => boolean): string {
  const mine = v.files.filter(where);
  if (!mine.length) return '';
  return '<h3>Files</h3><ul>' + mine.map((f) => `<li>📎 ${escapeHtml(f.name)} <span class="dim">${escapeHtml(f.mime)} · ${f.size} bytes · `
    + `${f.author === 'CLAUDE' ? 'Claude' : 'User'} · ${escapeHtml(f.createdAt)}</span></li>`).join('') + '</ul>';
}

export function widgetsHtml(kit: FrameKit, v: BoardVisuals): string {
  if (!v.widgets.length) return '';
  return '<h2>Widgets</h2>' + v.widgets.map((w) => w.kind === 'BLOCK'
    ? `<div class="vis"><div class="vis-h">★ ${escapeHtml(w.name)}</div><div class="t r">${blocksToHtml(textBlocks(w.source ?? ''))}</div></div>`
    : snippetHtml(kit, v, { source: w.source ?? '', info: w.info, lang: LANG[w.kind] ?? 'html', snippetId: `widget:${w.name}`, name: `★ ${w.name}` })).join('');
}

export const VISUALS_CSS = '.vis{border:1px solid #dde0ee;border-radius:8px;margin:.6rem 0;padding:.4rem .6rem;background:#0b0f2a;color:#e5e9f5}'
  + '.vis-h{font-weight:600;font-size:.8rem;color:#c4b5fd;margin-bottom:.3rem}.vis iframe.snip{width:100%;border:0;display:block;background:transparent}'
  + '.vis img.shot{max-width:100%;display:block;margin:.3rem 0}.vis pre{background:#070a24;color:#e5e9f5;white-space:pre-wrap;padding:.4rem}'
  + '.vis .t.r{background:#fff;color:#1d2340}.vis summary{cursor:pointer}';
