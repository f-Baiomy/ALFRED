import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { pickState } from '../src/tools/team.ts';

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
    if (method === 'GET' && p[3] === 'saved') {
      return [200, [{ id: 5, name: 'My open bugs', lastCount: 7, query: { types: ['Bug'], assigned: ['me'], openOnly: true, show: 'ITEMS', tagsAll: true, tags: ['uat', 'refund'] } }]];
    }
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
    if (p[1] === 'cards' && p[3] === 'matches') {
      const match = (why: string) => ({ row: { boardId: 'b1', cardId: p[2], conn: 'c1', item: '1300', state: 'PROPOSED', why, score: 0.75, at: null },
        type: 'Bug', title: 'Refund total is wrong', state: 'New' });
      if (method === 'GET') return [200, [match('shared words: refund, total')]];
      if (method === 'PUT' && p[6] === 'why') return [200, [match(body.why)]];
    }
    if (method === 'POST' && p[1] === 'cards' && p[3] === 'items') return [200, { items: [], bundle: { ...BUNDLE, id: 9, title: 'Link card #4 in Azure' } }];
    if (method === 'DELETE' && p[1] === 'cards') return [403, { error: 'USER_ONLY', message: 'Only the user unlinks a card from an item' }];
    if (method === 'POST' && p[1] === 'items' && p[4] === 'start') {
      return body.target ? [202, { state: 'WAITING', project: body.target.project, boardId: null, messageId: 41 }]
        : [409, { error: 'NEEDS_TARGET', message: 'Pick the Alfred project' }];
    }
    if (method === 'POST' && p[1] === 'items' && p[4] === 'board') {
      return [201, { boardId: 'nb1', project: body.project, name: body.name ?? '#' + p[3] + '_Refund a card', main: body.main, cycle: body.cycle,
        files: { attached: [], notAttached: [] }, note: null, askedIn: body.askedIn }];
    }
    if (method === 'PUT' && p[1] === 'links') return [200, { attached: ['trace.txt'], notAttached: ['huge.zip (over the size limit)'] }];
    if (method === 'GET' && p[1] === 'items' && p[4] === 'seed') {
      return [200, { item: VIEW.item, provider: 'Azure DevOps', purpose: 'Refund throws 500', steps: null, acceptance: '1. Refund works', context: null,
        parentAcceptance: 'Epic acceptance', children: ['1300 · Bug · Fix it · Active'], attachments: [], links: [], board: 'b1',
        childItems: [{ id: '1300', type: 'Bug', title: 'Fix it', state: 'Resolved', category: 'Resolved', done: true, assignee: 'Omar', url: null,
          purpose: '<p>Broken</p>', steps: LONG, acceptance: null, context: null, comments: [{ by: 'QC', at: '2026-10-16T11:00:00Z', text: 'Seen' }],
          grandchildren: ['1301 · Task · Sub · New'] }],
        parents: [{ id: '99', type: 'Feature', title: 'Refunds', state: 'Active', url: null, purpose: 'Refunds', acceptance: 'F1' },
          { id: '9', type: 'Epic', title: 'Refunds 2026', state: 'Active', url: null, purpose: null, acceptance: 'E1' }],
        comments: [{ by: 'Sara', at: '2026-10-15T09:00:00Z', text: 'Agreed in review' }] }];
    }
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

test('team_saved lists the pills; team_search saved runs one, a filter beside it replacing that filter', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const l = await w.call('team_saved', {});
    assert.deepEqual(l.json.saved, ['"My open bugs" (7 last time): type: Bug · assigned: me · tags: uat and refund']);
    await w.call('team_search', { saved: 'my open BUGS', states: ['Active'] });
    const req = w.fake.requests('POST', '/teamboards/connections/c1/search')[0];
    assert.deepEqual([req.body.types, req.body.assigned, req.body.states, req.body.saved, req.body.tagsAll, req.body.show],
      [['Bug'], ['me'], ['Active'], 5, true, 'ITEMS']);
    const none = await w.call('team_search', { saved: 'nope' });
    assert.ok(none.isError);
    assert.match(none.json.message, /No saved search "nope" - saved: "My open bugs"/);
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

test('team_item seed has every child in full, the parents up to the top and the comments, each paged, never cut (specs/030)', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_item', { id: '1234', seed: true });
    assert.deepEqual(r.json.counts, { children: 1, done: 1, parents: 2, comments: 1 });
    assert.match(r.json.seed.children, /^### 1300 · Bug · Fix it · Resolved · DONE in the tracker · Omar\nPurpose:\nBroken\nSteps:\nx+/);
    assert.match(r.json.seed.children, /more characters: team_item seed part "children" offset \d+\]$/);
    assert.match(r.json.seed.parents, /### up · 99 · Feature · Refunds · Active[\s\S]*### up up · 9 · Epic · Refunds 2026 · Active\nAcceptance:\nE1/);
    assert.match(r.json.seed.comments, /Sara \(2026-10-15\): Agreed in review/);
    const all: string[] = [];
    for (let offset = 0; offset !== null;) {
      const part = await w.call('team_item', { id: '1234', seed: true, part: 'children', offset });
      all.push(part.json.text);
      offset = part.json.nextOffset;
    }
    const text = all.join('');
    assert.ok(text.includes('x'.repeat(20_000)), 'the long repro is whole across the parts');
    assert.match(text, /Comments:\n {2}- QC \(2026-10-16\): Seen\nIts children: 1301 · Task · Sub · New$/);
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

test('team_card_matches lists the proposed items of a card with the reason; why replaces it as Claude, never links (specs/030)', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    seedCard(w);
    const m = await w.call('team_card_matches', { project: 'odeysys', number: 4 });
    assert.deepEqual(m.json.matches, [{ item: 'c1/1300 · Bug · "Refund total is wrong" · New · score 0.75', why: 'shared words: refund, total' }]);
    assert.match(m.json.note, /Only the user links or rejects/);

    const j = await w.call('team_card_matches', { project: 'odeysys', number: 4, id: 'AB#1300', why: 'Same total screen as the card call' });
    assert.equal(j.json.matches[0].why, 'Same total screen as the card call');
    const put = w.fake.requests('PUT', '/teamboards/cards/card-4/matches/c1/1300/why')[0];
    assert.equal(put.body.why, 'Same total screen as the card call');
    assert.equal(put.headers?.['x-alfred-actor'], 'claude');

    const none = await w.call('team_card_matches', { project: 'odeysys', number: 4, id: '999', why: 'x' });
    assert.ok(none.isError);
    assert.match(none.text, /not a proposed match/);
    assert.equal(w.fake.requests('POST', '/teamboards/cards/card-4/matches').length, 0, 'Claude never links or rejects');
  } finally { await w.close(); }
});

test('team_refresh_item on a board syncs now and says what changed, the main move and the matches (specs/030)', async () => {
  const w = await world();
  try {
    const base = team();
    w.fake.team = (method, p, q, body) => {
      if (method === 'POST' && p[1] === 'boards' && p[3] === 'sync') {
        assert.deepEqual(body, { force: true, wait: true });
        return [200, { boardId: p[2], checked: 3, changed: 1, newInTree: 1, leftTree: 0, skipped: false,
          newItems: [{ conn: 'c1', item: '1310', type: 'Bug', title: 'Refund twice', state: 'New' }],
          changedItems: [{ conn: 'c1', item: '1234', title: 'Refund fails', fields: ['System.State', 'comments'], newComments: 2 }],
          mainState: { conn: 'c1', item: '1234', fromState: 'Active', toState: 'Removed', category: 'Removed', closed: true,
            fromIteration: 'Sprint 12', toIteration: 'Sprint 12' }, matches: 1 }];
      }
      return base(method, p, q, body);
    };
    w.fake.board.extra = (method: string, p: string[]) => method === 'GET' && p[1] === 'boards' && p[2] === 'b1'
      ? [200, { board: { id: 'b1', project: 'odeysys', name: 'Refunds', isDefault: false, state: 'OPEN' }, cards: 0, cycleIds: [], boardIds: [], linkedItem: 'c1/1234' }]
      : undefined;
    const r = await w.call('team_refresh_item', { board: 'b1' });
    assert.equal(r.json.summary, '1 changed · 1 new in the tree · 0 left the tree · 1 possible card matches');
    assert.deepEqual(r.json.newItems, ['c1/1310 · Bug · "Refund twice" · New (waits in Incoming)']);
    assert.match(r.json.changedItems[0], /System\.State, comments · 2 new comment/);
    assert.match(r.json.mainMoved, /Active → Removed \(Removed\) · CLOSED in the tracker/);
    assert.match(r.json.next, /team_card_matches/);
  } finally { await w.close(); }
});

test('a state the type does not have becomes the closest of the same kind, said so (specs/030)', () => {
  const states = [
    { type: 'Bug', name: 'Resolved', category: 'Resolved' }, { type: 'Bug', name: 'Closed', category: 'Completed' },
    { type: 'Task', name: 'Active', category: 'InProgress' }, { type: 'Task', name: 'Done', category: 'Completed' },
  ];
  assert.deepEqual(pickState('Resolved', 'Bug', states), { state: 'Resolved' });
  const task = pickState('Closed', 'Task', states);
  assert.equal(task.state, 'Done');
  assert.match(task.note!, /"Closed" is not a state of Task here - proposed "Done" \(Completed\)/);
  assert.equal(pickState('Resolved', 'Task', states).state, 'Done', 'Resolved falls back to Completed');
  assert.deepEqual(pickState('Closed', 'Epic', states), { state: 'Closed' }, 'unknown type: as asked');
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

test('team_new_board needs askedIn and a project, defaults the name and a cycle that does not record', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const refused = await w.call('team_new_board', { id: 'AB#1234', project: 'odeysys' });
    assert.ok(refused.isError, 'askedIn is required');
    const made = await w.call('team_new_board', { id: 'AB#1234', askedIn: 'm12', project: 'odeysys' });
    assert.equal(made.json.board, 'nb1');
    assert.equal(made.json.name, '#1234_Refund a card');
    assert.equal(made.json.cycle, 'NEW');
    assert.equal(made.json.main, true);
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
