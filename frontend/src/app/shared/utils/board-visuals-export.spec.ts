import { CardDetail } from '../../core/models/board.models';
import { SnippetPage } from '../../core/models/snippet.models';
import { BoardExport, buildBoardJsonLines } from './board-json';
import { buildBoardHtmlParts } from './board-html-builder';
import { buildBoardMarkdownLines } from './board-md-builder';
import { BoardVisuals, exportedSnippetId, stateAnswers } from './board-visuals-export';
import { textSnippets } from './board-visuals-render';
import { buildSnippetDoc, declaredData, staticAnswerKey } from './snippet-frame';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function card(id: string, number: number, description: string): CardDetail {
  return { id, project: 'p', number, kind: 'BUG', title: 'Fares', description, status: 'INBOX', resolution: null, reason: null, flags: [], teams: [],
    scope: 'NOT_DECIDED', author: 'USER', cycleId: null, cycleDeleted: false, signature: null, createdAt: '', updatedAt: '', updatedBy: 'USER', links: [] } as unknown as CardDetail;
}

const page: SnippetPage = { id: 'pg-1', ownerType: 'CARD', ownerId: 'c-1', project: 'p', cardId: 'c-1', cycleId: null, name: 'Dash', kind: 'HTML',
  info: 'live', source: '<b id="v"></b><script>alfred.state.get("n").then(function (n) { document.getElementById("v").textContent = "n=" + n; '
    + 'parent.postMessage({ probe: "offline", v: "n=" + n }, "*"); });</script>',
  author: 'CLAUDE', pinned: true, position: 0, version: 2, createdAt: '', updatedAt: '', updatedBy: 'CLAUDE' };

const visuals: BoardVisuals = {
  pages: [{ owner: 'card', cardNumber: 7, page, versions: [
    { snippetId: 'pg-1', version: 2, name: 'Dash', info: 'live', source: page.source, size: 1, author: 'CLAUDE', at: '' },
    { snippetId: 'pg-1', version: 1, name: 'Dash', info: 'live', source: '<i>old</i>', size: 1, author: 'CLAUDE', at: '' }] }],
  states: [{ snippetId: 'page:pg-1', key: 'n', value: '41', updatedBy: 'USER', at: '' }],
  shots: [{ snippetId: 'page:pg-1', version: 2, png: PNG, console: '', at: '2026-10-14' }, { snippetId: 'inline:card:#7:desc:0', version: 1, png: PNG, console: '', at: '' }],
  files: [{ id: 'f-12345678', cardNumber: 7, name: 'rows.csv', mime: 'text/csv', size: 7, author: 'USER', createdAt: '', data: 'YSxiCjEsMgo=' }],
  widgets: [{ project: 'p', name: 'fares', kind: 'BLOCK', info: '', source: '```stats\nA | {{a}}\n```', author: 'USER', updatedAt: '', updatedBy: 'USER' }],
};

const data: BoardExport = {
  project: 'p', cards: [card('c-1', 7, 'Look:\n\n```html live name="Totals"\n<p>t</p>\n```')], activity: {}, briefs: [], specs: [], marks: [], visuals,
};

describe('board export of the visuals (specs/017 R35, R43)', () => {
  it('writes ids the importer maps back: pages as page:<id>, inline blocks by card number', () => {
    const numbers = new Map([['c-1', 7]]);
    expect(exportedSnippetId('pg-1', (c) => numbers.get(c), new Set(['pg-1']))).toBe('page:pg-1');
    expect(exportedSnippetId('inline:card:c-1:42p1:0', (c) => numbers.get(c), new Set())).toBe('inline:card:#7:42p1:0');
    expect(exportedSnippetId('inline:cycle:cy-1:goal:0', () => undefined, new Set())).toBe('inline:cycle:cy-1:goal:0');
  });

  it('.json: every page with every version, values, pictures, files with their bytes and widgets - nothing shortened', () => {
    const lines = buildBoardJsonLines(data, '2026-10-14T00:00:00Z').map((l) => JSON.parse(l));
    const rec = (k: string) => lines.filter((l) => l.record === k);
    expect(rec('page')[0]).toEqual(jasmine.objectContaining({ owner: 'card', cardNumber: 7, id: 'pg-1', source: page.source, pinned: true, version: 2 }));
    expect(rec('page')[0].versions.map((v: { source: string }) => v.source)).toEqual([page.source, '<i>old</i>']);
    expect(rec('state')[0]).toEqual(jasmine.objectContaining({ snippetId: 'page:pg-1', key: 'n', value: '41' }));
    expect(rec('shot').length).toBe(2);
    expect(rec('file')[0]).toEqual(jasmine.objectContaining({ id: 'f-12345678', cardNumber: 7, data: 'YSxiCjEsMgo=' }));
    expect(rec('widget')[0]).toEqual(jasmine.objectContaining({ name: 'fares', kind: 'BLOCK', source: '```stats\nA | {{a}}\n```' }));
  });

  it('.md: the page source whole with its picture embedded, inline pictures, files and widgets', () => {
    const md = buildBoardMarkdownLines(data, 'Board').join('\n');
    expect(md).toContain('#### 📌 Dash (html, v2, by Claude)');
    expect(md).toContain(page.source!);
    expect(md).toContain(`![Dash - as drawn, v2](data:image/png;base64,${PNG})`);
    expect(md).toContain('Description, snippet 1:');
    expect(md).toContain('- 📎 rows.csv · text/csv');
    expect(md).toContain('### ★ fares (block)');
  });

  it('.html: each snippet runs in a locked offline frame with its libraries and answers inside', () => {
    const html = buildBoardHtmlParts(data, 'Board', { origin: 'http://alfred.test', libCode: {}, data: {} }).join('');
    const frames = [...html.matchAll(/<iframe class="snip" sandbox="allow-scripts"/g)];
    expect(frames.length).toBe(2); // the description's snippet and the page
    expect(html).not.toContain('allow-same-origin');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const srcdoc = doc.querySelectorAll('iframe')[1].getAttribute('srcdoc')!;
    const boot = JSON.parse(new DOMParser().parseFromString(srcdoc, 'text/html').getElementById('alfred-boot')!.textContent!);
    expect(boot.offline).toBeTrue();
    expect(boot.static[staticAnswerKey('state.get', { key: 'n' })]).toBe(41);
    expect(html).toContain(`src="data:image/png;base64,${PNG}"`);
    expect(textSnippets('```html live\na\n```\n\n:::tabs\n## X\n```mermaid\ngraph LR\n```\n:::').map((b) => b.lang)).toEqual(['html', 'mermaid']);
  });

  it('an offline frame answers from what was captured, inside a real locked frame', async () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    const got = new Promise<string>((resolve) => {
      const on = (e: MessageEvent) => { if (e.source === frame.contentWindow && e.data?.probe === 'offline') { window.removeEventListener('message', on); resolve(e.data.v); } };
      window.addEventListener('message', on);
    });
    frame.srcdoc = buildSnippetDoc({ source: page.source!, origin: location.origin, inline: {}, offline: true,
      staticAnswers: stateAnswers(visuals.states, 'page:pg-1', staticAnswerKey) });
    document.body.appendChild(frame);
    expect(await got).toBe('n=41');
    frame.remove();
  });

  it('reads declared data blocks so an export can answer them ahead', () => {
    expect(declaredData('<script type="alfred/data" name="c" src="calls" live>{"since":"24h"}</script><script type="alfred/data" src="cards"></script>'))
      .toEqual([{ src: 'calls', args: { since: '24h' } }, { src: 'cards', args: {} }]);
    expect(staticAnswerKey('data', { src: 'calls', args: { since: '24h' }, live: 'w1' })).toBe('data:{"src":"calls","args":{"since":"24h"}}');
  });
});
