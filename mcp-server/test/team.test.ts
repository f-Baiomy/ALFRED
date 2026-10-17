import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

const CONN = { id: 'c1', kind: 'azure', name: 'Contoso', capabilities: ['SEARCH', 'WRITE'] };
const SARA = { extId: 'p1', name: 'Sara Ali', email: 'sara@x' };
const ROW = { id: '1234', type: 'Bug', title: 'Refund fails', state: 'Active', stateCategory: 'InProgress', assigned: SARA, iteration: 'Proj\\Sprint 12',
  area: 'Proj', changedAt: '2026-10-16T10:00:00Z', rev: 3, url: 'https://dev.azure.com/x/_workitems/edit/1234',
  boards: [{ boardId: 'b1', name: 'Refunds', role: 'MAIN', copyRev: 2, changed: true }], cards: [] };
const LONG = 'x'.repeat(20_000);
const VIEW = {
  item: { extId: '1234', type: 'Bug', title: 'Refund fails', state: 'Active', assignee: 'sara@x', squad: null, sprint: 'Proj\\Sprint 12', area: 'Proj',
    url: ROW.url, rev: 3, changedAt: ROW.changedAt, fields: { 'System.Description': '<p>Refund <b>throws</b> 500</p>', 'Microsoft.VSTS.TCM.ReproSteps': LONG },
    links: [{ toId: '99', kind: 'Parent' }], identities: { assigned: SARA, changed: SARA } },
  stateCategory: 'InProgress', comments: [{ id: '1', by: 'Omar', at: '2026-10-16T11:00:00Z', text: '<div>Seen on prod</div>' }], history: null,
  attachments: [{ name: 'trace.txt', mime: 'text/plain', size: 3 }], copyRev: 2, diff: [{ field: 'System.State', from: 'New', to: 'Active' }],
  boards: ROW.boards, cards: [],
};
const BUNDLE = { id: 7, title: 'Comment on item 1234', state: 'WAITING', steps: [{ kind: 'COMMENT', ticked: true }] };

function team(opts: { token?: boolean; conns?: unknown[] } = {}) {
  const token = opts.token ?? true;
  return (method: string, p: string[], _q: URLSearchParams, body?: any): [number, unknown?] | undefined => {
    const missing: [number, unknown] = [401, { error: 'TOKEN_MISSING', message: 'Enter your token in the Team tab' }];
    if (method === 'GET' && p[1] === 'connections' && p.length === 2) return [200, opts.conns ?? [CONN]];
    if (method === 'POST' && p[3] === 'search' && body.show === 'TREE') {
      return [200, { items: [{ ...ROW, parent: '99' }], total: 1, fullText: true, page: 0, pageSize: 50, show: 'TREE',
        context: [{ ...ROW, id: '99', title: 'Refunds epic', type: 'Epic', parent: null, boards: [] }, { ...ROW, id: '1300', title: 'Fix it', type: 'Task', parent: '1234', boards: [] }],
        contextLeftOut: 0 }];
    }
    if (method === 'POST' && p[3] === 'search') return token ? [200, { items: [ROW], total: 120, fullText: false, page: body.page ?? 0, pageSize: 50 }] : missing;
    if (method === 'GET' && p[3] === 'items' && p[4] === '1234') return token ? [200, VIEW] : missing;
    if (method === 'POST' && p[1] === 'connections' && p[3] === 'items' && p.length === 4) return [200, [{ ...VIEW, item: { ...VIEW.item, extId: '99', title: 'Refunds epic', type: 'Epic' } }]];
    if (method === 'PATCH' && p[3] === 'items') return [200, BUNDLE];
    if (method === 'POST' && p[1] === 'writes') return [201, { ...BUNDLE, id: body.extend ?? 8 }];
    if (method === 'GET' && p[3] === 'me') return [200, { person: SARA, source: 'TOKEN_OWNER' }];
    if (method === 'GET' && p[3] === 'people' && p.length === 4) return [200, [SARA, { extId: 'p2', name: 'Omar', email: 'omar@x' }]];
    if (method === 'GET' && p[1] === 'boards' && p[3] === 'items') {
      const row = (item: string, role: string, relation: string, depth: number) => ({ row: { conn: 'c1', item, role, relation, linkKind: null, parent: null, depth,
        type: 'Bug', title: 'T' + item, state: 'Active', leftTreeAt: null }, hasCopy: role !== 'REF', copyRev: 2, changed: item === '1234', cards: [] });
      return [200, { main: row('1234', 'MAIN', 'ROOT', 0), items: [row('1235', 'REF', 'DESCENDANT', 1), row('1240', 'CARD', 'ADDED', 0)], syncedAt: null, live: true }];
    }
    if (method === 'POST' && p[1] === 'boards' && p[3] === 'items') {
      return body.askedIn ? [200, { main: null, items: [], syncedAt: null, live: true }] : [409, { error: 'CONFLICT', message: 'Waiting for the user: the link is a bundle' }];
    }
    if (method === 'POST' && p[1] === 'cards' && p[3] === 'items') return [200, { items: [], bundle: { ...BUNDLE, id: 9, title: 'Link card #4 in Azure' } }];
    if (method === 'DELETE' && p[1] === 'cards') return [403, { error: 'USER_ONLY', message: 'Only the user unlinks a card from an item' }];
    if (method === 'POST' && p[1] === 'items' && p[4] === 'start') {
      return body.target ? [202, { state: 'WAITING', project: body.target.project, boardId: null, messageId: 41 }]
        : [409, { error: 'NEEDS_TARGET', message: 'Pick the Alfred project' }];
    }
    if (method === 'PUT' && p[1] === 'links') return [200, { attached: ['trace.txt'], notAttached: ['huge.zip (over the size limit)'] }];
    return undefined;
  };
}

function seedCard(w: Awaited<ReturnType<typeof world>>): void {
  w.fake.board.cards.push({ id: 'card-4', project: 'odeysys', number: 4, kind: 'BUG', title: 'Refund 500', description: '', status: 'TO_DO', resolution: null,
    reason: null, flags: [], scope: 'IN_FLOW', author: 'USER', cycleId: null, cycleDeleted: false, updatedAt: '2026-10-10T09:00:00Z', commentCount: 0,
    similarClosed: null, links: [], teams: [] } as never);
}

test('team_search reads live as Claude, says titles-only and pages, and shows where a row sits in Alfred', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_search', { text: 'refund', mine: true, iterations: ['@current'] });
    assert.equal(r.json.total, 120);
    assert.equal(r.json.page, '1 of 3');
    assert.match(r.json.note, /titles were matched/);
    assert.equal(r.json.items[0], '1234 · Bug · "Refund fails" · Active · Sara Ali · Sprint 12 · in Alfred: main of Refunds (changed since the copy)');
    const req = w.fake.requests('POST', '/teamboards/connections/c1/search')[0];
    assert.deepEqual(req.body.mine, ['ASSIGNED', 'CREATED', 'CHANGED', 'MENTIONED', 'FOLLOWED']);
    assert.equal(req.body.openOnly, true);
    assert.equal(req.headers?.['x-alfred-actor'], 'claude');
    assert.ok(!JSON.stringify(req.headers ?? {}).toLowerCase().includes('team-token'), 'no token header from Claude');
  } finally { await w.close(); }
});

test('team_search takes several values per filter and shows the tree with context marked', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_search', { assigned: ['me', 'none'], createdBy: 'me', parent: '59415', tagsAll: true, show: 'tree' });
    const req = w.fake.requests('POST', '/teamboards/connections/c1/search')[0];
    assert.deepEqual([req.body.assigned, req.body.createdBy, req.body.parents, req.body.show, req.body.tagsAll, req.body.childDepth],
      [['me', 'none'], ['me'], ['59415'], 'TREE', true, 1]);
    assert.equal(req.body.parent, undefined);
    assert.equal(r.json.tree.length, 3);
    assert.match(r.json.tree[0], /^99 · Epic · "Refunds epic".*\(parent\)$/);
    assert.match(r.json.tree[1], /^  1234 · Bug · "Refund fails"/);
    assert.doesNotMatch(r.json.tree[1], /\((parent|child)\)$/);
    assert.match(r.json.tree[2], /^    1300 · Task · "Fix it".*\(child\)$/);
  } finally { await w.close(); }
});

test('with no token live a read says TOKEN_MISSING and to ask the user - never for the token itself', async () => {
  const w = await world();
  try {
    w.fake.team = team({ token: false });
    const r = await w.call('team_search', { text: 'x' });
    assert.ok(r.isError);
    assert.match(r.text, /TOKEN_MISSING: no token is live - ask the user to enter their personal access token in the Team tab/);
    assert.match(r.text, /do not ask for it in chat/);
  } finally { await w.close(); }
});

test('team_item reads fields as text, pages a long field, and shows the diff against the saved copy', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_item', { id: 'https://dev.azure.com/x/_workitems/edit/1234' });
    assert.equal(r.json.fields['System.Description'], 'Refund throws 500');
    assert.match(r.json.fields['Microsoft.VSTS.TCM.ReproSteps'], /more characters: team_item field "Microsoft.VSTS.TCM.ReproSteps" offset 3000\]$/);
    assert.deepEqual(r.json.changedSinceCopy, ['System.State: New → Active']);
    assert.deepEqual(r.json.comments, ['2026-10-16T11:00:00Z Omar: Seen on prod']);
    assert.equal(r.json.assigned, 'Sara Ali <sara@x>');
    const part = await w.call('team_item', { id: '1234', field: 'Microsoft.VSTS.TCM.ReproSteps', offset: 12_000 });
    assert.equal(part.json.text.length, 8_000);
  } finally { await w.close(); }
});

test('team_board_items lists main, card items and references; team_tree reads an item\'s links live', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const b = await w.call('team_board_items', { board: 'b1' });
    assert.match(b.json.main, /★ 1234 · Bug · "T1234" · Active · full copy rev 2 · CHANGED since the copy/);
    assert.equal(b.json.cardItems.length, 1);
    assert.equal(b.json.references.length, 1);
    const t = await w.call('team_tree', { id: '1234' });
    assert.deepEqual(t.json.links, ['Parent → 99 · Epic · "Refunds epic" · Active']);
  } finally { await w.close(); }
});

test('writes are bundles that wait for the user: comment, state, extend, link a card, board link without askedIn', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    seedCard(w);
    const c = await w.call('team_comment', { id: '1234', text: 'Fixed in build 41', project: 'odeysys', number: 4 });
    assert.equal(c.json.state, 'WAITING');
    assert.match(c.json.note, /Waits for the user/);
    const patch = w.fake.requests('PATCH', '/teamboards/connections/c1/items/1234')[0];
    assert.deepEqual([patch.body.comment, patch.body.card], ['Fixed in build 41', 'card-4']);

    const none = await w.call('team_move_state', { id: '1234', state: 'Resolved' });
    assert.match(none.text, /Name the card/);
    assert.equal(w.fake.requests('PATCH', '/teamboards/connections/c1/items/1234').length, 1);

    const s = await w.call('team_move_state', { id: '1234', state: 'Resolved', extend: 7 });
    assert.equal(s.json.bundle, 7);
    assert.equal(w.fake.requests('POST', '/teamboards/writes')[0].body.steps[0].kind, 'STATE');

    const l = await w.call('team_link_card', { project: 'odeysys', number: 4, id: 'AB#1234' });
    assert.equal(l.json.linked, 'not yet - waits for the user');
    assert.equal(l.json.bundle, 9);

    const bl = await w.call('team_board_link', { board: 'b1', id: '1234' });
    assert.equal(bl.json.result, 'proposed');

    const un = await w.call('team_unlink_card', { project: 'odeysys', number: 4, id: '1234' });
    assert.ok(un.isError);
    assert.match(un.text, /Only the user unlinks/);
    assert.equal(w.fake.requests('POST', '/teamboards/writes/').filter((r) => r.path.endsWith('/approve')).length, 0, 'Claude never approves');
  } finally { await w.close(); }
});

test('team_people names people and says who "me" is', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_people', { query: 'om' });
    assert.match(r.json.me, /Sara Ali <sara@x> \(the token owner\)/);
    assert.deepEqual(r.json.people, ['Omar <omar@x> · id p2']);
  } finally { await w.close(); }
});

test('team_start needs askedIn and asks for a target when unmapped; team_link reports the attachments; several connections need conn', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const refused = await w.call('team_start', { id: 'AB#1234' });
    assert.ok(refused.isError, 'askedIn is required');
    const asked = await w.call('team_start', { id: 'AB#1234', askedIn: 'm12' });
    assert.equal(asked.json.result, 'NEEDS_TARGET');
    const started = await w.call('team_start', { id: 'AB#1234', askedIn: 'm12', project: 'odeysys' });
    assert.equal(started.json.result, 'WAITING');

    const linked = await w.call('team_link', { board: 'b-refund', id: 'AB#1234' });
    assert.deepEqual(linked.json.attached, ['trace.txt']);
    assert.match(linked.json.note, /Fetch attachments/);

    w.fake.team = team({ conns: [CONN, { ...CONN, id: 'c2', name: 'Other' }] });
    const several = await w.call('team_search', {});
    assert.match(several.text, /Several connections - pass conn: c1 \(Contoso\), c2 \(Other\)/);
  } finally { await w.close(); }
});

test('the cache tools are gone', async () => {
  const w = await world();
  try {
    for (const name of ['team_items', 'team_changes', 'team_squads']) {
      const r = await w.call(name, {});
      assert.ok(r.isError, `${name} no longer exists`);
    }
  } finally { await w.close(); }
});
