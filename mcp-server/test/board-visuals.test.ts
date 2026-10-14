import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

const PAGE = { id: '11111111-2222-3333-4444-555555555555', ownerType: 'CARD', ownerId: 'card-1', project: 'p', name: 'Totals', kind: 'HTML',
  info: 'live libs="echarts"', source: 'x'.repeat(30_000), author: 'CLAUDE', pinned: false, version: 3, updatedAt: '2026-10-14T09:00:00Z', updatedBy: 'CLAUDE' };

test('board_ask_get reads the question with its data; board_ask_answer answers as Claude', async () => {
  const w = await world();
  try {
    w.fake.board.extra = (method, p) => {
      if (method === 'GET' && p[1] === 'asks' && p[2] === 'ask-12345678') {
        return [200, { id: 'ask-12345678', project: 'p', cycleId: 'c1', cardNumber: 4, snippetId: null, kind: 'EDITOR', question: 'Shorten this',
          data: JSON.stringify({ selection: 'a long text', text: 'all of it', format: 'markdown' }), state: 'OPEN', answer: null, createdAt: '' }];
      }
      if (method === 'PUT' && p[1] === 'asks') return [200, { id: p[2], state: 'ANSWERED' }];
      return undefined;
    };
    const r = await w.call('board_ask_get', { id: 'ask-12345678' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.kind, 'EDITOR');
    assert.equal(r.json.card, '#4');
    assert.equal(r.json.data.selection, 'a long text');
    assert.match(r.json.how, /replacement text only/);

    const a = await w.call('board_ask_answer', { id: 'ask-12345678', text: 'Short.' });
    assert.equal(a.isError, false, a.text);
    const put = w.fake.requests('PUT', '/board/asks/ask-12345678/answer');
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, { text: 'Short.' });
    assert.equal(put[0]!.headers!['x-alfred-actor'], 'claude');
  } finally { await w.close(); }
});

test('board_page_put creates on a card by number, saves a version with baseVersion; board_page_get reads in parts', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.extra = (method, p, q, body) => {
      if (method === 'POST' && p[1] === 'pages') return [201, { ...PAGE, ...body, kind: body.kind, version: 1 }];
      if (method === 'GET' && p[1] === 'pages') return [200, [PAGE]];
      if (method === 'PUT' && p[1] === 'snippets') return [200, { ...PAGE, version: 4 }];
      if (method === 'GET' && p[1] === 'snippets' && p.length === 3) return [200, PAGE];
      return undefined;
    };
    const c = await w.call('board_page_put', { project: 'p', number: 1, name: 'Totals', source: '<b>hi</b>' });
    assert.equal(c.isError, false, c.text);
    const post = w.fake.requests('POST', '/board/pages')[0];
    assert.equal(post.body.owner, 'card:card-1');
    assert.equal(post.body.kind, 'HTML');
    assert.equal(post!.headers!['x-alfred-actor'], 'claude');

    const u = await w.call('board_page_put', { project: 'p', id: PAGE.id, name: 'Totals', source: 'new', baseVersion: 3 });
    assert.equal(u.json.saved.version, 4);
    assert.equal(w.fake.requests('PUT', `/board/snippets/${PAGE.id}`)[0].body.baseVersion, 3);

    const list = await w.call('board_pages', { project: 'p', number: 1 });
    assert.equal(list.json.pages[0].name, 'Totals');
    assert.equal(list.json.pages[0].source, undefined, 'the list stays short - the source is read with board_page_get');

    const g = await w.call('board_page_get', { id: PAGE.id });
    assert.equal(g.json.totalLength, 30_000);
    assert.equal(g.json.source.length, 12_000);
    const rest = await w.call('board_page_get', { id: PAGE.id, offset: g.json.nextOffset });
    assert.equal(rest.json.offset, 12_000);
  } finally { await w.close(); }
});

test('a page with no place is refused before Alfred is asked', async () => {
  const w = await world();
  try {
    const r = await w.call('board_page_put', { project: '', name: 'x', source: 'y' });
    assert.equal(r.isError, true);
    assert.equal(w.fake.requests('POST', '/board/pages').length, 0);
  } finally { await w.close(); }
});

test('board_snippet_view returns the picture and the console; none yet says why', async () => {
  const w = await world();
  try {
    w.fake.board.extra = (method, p, q) => {
      if (method === 'GET' && p[1] === 'snippets' && p[3] === 'shot' && q.get('png') === 'false') {
        return p[2] === 'none-0000' ? [404, { error: 'not-found' }] : [200, { snippetId: p[2], version: 2, at: '2026-10-14T09:00:00Z', console: 'error: x is not defined' }];
      }
      return undefined;
    };
    const raw = await w.client.callTool({ name: 'board_snippet_view', arguments: { id: 'inline:card:card-1:desc:0' } }) as { content: any[]; isError?: boolean };
    assert.ok(!raw.isError, JSON.stringify(raw));
    assert.match(raw.content[0].text, /x is not defined/);
    assert.equal(raw.content[1].type, 'image');
    assert.equal(raw.content[1].mimeType, 'image/png');
    const none = await w.call('board_snippet_view', { id: 'none-0000' });
    assert.equal(none.isError, true);
    assert.match(none.text, /opens it on the board/);
  } finally { await w.close(); }
});

test('board_lib lists the shelf', async () => {
  const w = await world();
  try {
    const r = await w.call('board_lib');
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.libs[0].id, 'echarts');
    assert.equal(r.json.libs[0].file, undefined);
  } finally { await w.close(); }
});

test('files: list, read in parts, attach as Claude with a link to paste', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.extra = (method, p, q, body) => {
      if (method === 'GET' && p[1] === 'files' && p.length === 2) return [200, [{ id: 'f-12345678', name: 'rows.csv', mime: 'text/csv', size: 7, author: 'USER', createdAt: '', cardId: q.get('card'), cycleId: null }]];
      if (method === 'GET' && p[1] === 'files' && p[2] === 'f-12345678') return [200, 'a,b;1,2'];
      if (method === 'POST' && p[1] === 'files') return [201, { id: 'f-87654321', name: q.get('name'), mime: 'text/csv', size: String(body).length, author: 'CLAUDE', createdAt: '', cardId: q.get('card'), cycleId: null }];
      return undefined;
    };
    const list = await w.call('board_files', { project: 'p', number: 1 });
    assert.equal(list.json.files[0].name, 'rows.csv');
    assert.equal(w.fake.requests('GET', '/board/files')[0]!.query.get('card'), 'card-1');
    const read = await w.call('board_file', { id: 'f-12345678' });
    assert.match(read.json.text, /a,b;1,2/);
    const att = await w.call('board_attach', { project: 'p', number: 1, name: 'slow.csv', text: 'endpoint,ms\n/a,10' });
    assert.equal(att.isError, false, att.text);
    const post = w.fake.requests('POST', '/board/files')[0]!;
    assert.equal(post.body, 'endpoint,ms\n/a,10');
    assert.equal(post.headers!['x-alfred-actor'], 'claude');
    assert.equal(att.json.link, '[📎 slow.csv](/board/files/f-87654321)');
    assert.equal((await w.call('board_files', { project: 'p' })).isError, true);
  } finally { await w.close(); }
});

test('pins and widgets go as Claude', async () => {
  const w = await world();
  try {
    w.fake.board.extra = (method, p, q, body) => {
      if (method === 'PUT' && p[1] === 'snippets') return [200, { ...PAGE, pinned: body.pinned }];
      if (method === 'GET' && p[1] === 'widgets' && p.length === 2) return [200, [{ project: 'p', name: 'fares', kind: 'BLOCK', info: '', author: 'USER', updatedAt: '' }]];
      if (method === 'GET' && p[1] === 'widgets') return [200, { project: 'p', name: p[2], kind: 'BLOCK', info: '', source: '```chart\n```', author: 'USER', updatedAt: '' }];
      if (method === 'PUT' && p[1] === 'widgets') return [200, { project: q.get('project'), name: p[2], kind: body.kind, info: body.info, source: body.source, author: 'CLAUDE', updatedAt: '' }];
      return undefined;
    };
    const pin = await w.call('board_pin', { id: PAGE.id });
    assert.equal(pin.json.pinned.pinned, true);
    assert.deepEqual(w.fake.requests('PUT', `/board/snippets/${PAGE.id}`)[0]!.body, { pinned: true });
    assert.equal((await w.call('board_widgets', { project: 'p' })).json.widgets[0].name, 'fares');
    assert.match((await w.call('board_widgets', { project: 'p', name: 'fares' })).json.source, /chart/);
    const put = await w.call('board_widget_put', { project: 'p', name: 'sql-heat', kind: 'block', source: '```stats\nSQL | {{n}}\n```' });
    assert.equal(put.json.use, '{{widget:sql-heat}}');
    const req = w.fake.requests('PUT', '/board/widgets/sql-heat')[0]!;
    assert.equal(req.body.kind, 'BLOCK');
    assert.equal(req.query.get('project'), 'p');
    assert.equal((await w.call('board_widget_put', { project: 'p', name: 'bad name', source: 'x' })).isError, true);
  } finally { await w.close(); }
});
