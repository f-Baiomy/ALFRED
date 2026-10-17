import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

const CONN = { id: 'c1', kind: 'azure', name: 'Contoso', fetchedAt: '2026-10-17T08:00:00Z', fetchedBy: 'Sara', newChanges: 2 };
const ITEM = { conn: 'c1', extId: '1234', type: 'Bug', title: 'Refund fails', state: 'Active', assignee: 'Sara', squad: 'Payments',
  sprint: 'Proj\\Sprint 12', url: 'https://dev.azure.com/x/_workitems/edit/1234', changedAt: '2026-10-16T10:00:00Z' };
const LONG = 'x'.repeat(20_000);

function team(conns = [CONN]) {
  return (method: string, p: string[], q: URLSearchParams, body?: any): [number, unknown?] | undefined => {
    if (method === 'POST' && p[1] === 'items' && p[4] === 'start') {
      return body.target ? [202, { state: 'WAITING', project: body.target.project, boardId: null, messageId: 41 }]
        : [409, { error: 'NEEDS_TARGET', message: 'Pick the Alfred project' }];
    }
    if (method === 'PUT' && p[1] === 'links') return [200, { attached: ['trace.txt'], notAttached: ['huge.zip (over the size limit)'] }];
    if (method !== 'GET') return undefined;
    if (p[1] === 'connections' && p.length === 2) return [200, conns];
    if (p[1] === 'connections' && p[3] === 'items') return [200, { items: [ITEM], total: q.get('q') === 'refund' ? 1 : 1 }];
    if (p[1] === 'items' && p[2] === 'c1' && p[3] === '1234' && p.length === 4) {
      return [200, { item: ITEM, board: null, links: [{ toId: '99', kind: 'Parent' }], fields: [
        { key: 'System.Description', value: 'Refund throws 500', mappedTo: 'PURPOSE' },
        { key: 'Microsoft.VSTS.TCM.ReproSteps', value: LONG, mappedTo: 'STEPS' },
        { key: 'Custom.Notes', value: 'see logs', mappedTo: null },
      ] }];
    }
    if (p[1] === 'items' && p[2] === 'c1' && p[3] === '1234' && p[4] === 'seed') {
      return [200, { item: ITEM, provider: 'Azure DevOps', purpose: 'Refund throws 500', steps: LONG, acceptance: null, context: 'Custom.Notes: see logs',
        parentAcceptance: 'Refunds go to the card', children: [], attachments: [{ name: 'trace.txt', size: 3, url: 'https://dev.azure.com/x/a/1' }],
        links: [{ toId: '99', kind: 'Parent' }], board: null }];
    }
    if (p[1] === 'connections' && p[3] === 'changes') {
      return [200, [{ id: 7, extId: '1234', rev: 3, by: 'Sara', at: '2026-10-16T10:00:00Z', summary: 'State Active → Resolved', title: 'Refund fails', fresh: true }]];
    }
    if (p[1] === 'connections' && p[3] === 'squads') {
      return [200, [{ extId: 's1', name: 'Payments', project: 'Proj', alfredProject: 'odeysys', alfredTeam: 'backend', members: ['Sara', 'Omar'] }]];
    }
    return undefined;
  };
}

test('team_items reads the cache with filters and says how fresh it is', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_items', { q: 'refund', squad: 'Payments' });
    assert.match(r.json.connection, /Contoso \(azure\) · fetched 2026-10-17T08:00:00Z by Sara/);
    assert.deepEqual(r.json.items, ['1234 · Bug · "Refund fails" · Active · Sara · Payments · Sprint 12']);
    const req = w.fake.requests('GET', '/teamboards/connections/c1/items')[0];
    assert.ok(req, 'asked the cache');
  } finally { await w.close(); }
});

test('team_item reads the seed: parts by target, the parent, attachments; a long part is read in parts, never cut', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_item', { id: 'AB#1234' });
    assert.equal(r.json.seed.purpose, 'Refund throws 500');
    assert.equal(r.json.seed.parentAcceptance, 'Refunds go to the card');
    assert.match(r.json.seed.steps, /\[… 17000 more characters: team_item part "steps" offset 3000\]$/);
    assert.deepEqual(r.json.attachments, ['trace.txt (3 bytes) https://dev.azure.com/x/a/1']);
    let read = '';
    for (let offset: number | null = 0; offset !== null;) {
      const part = await w.call('team_item', { id: 'c1/1234', part: 'steps', offset });
      read += part.json.text;
      offset = part.json.nextOffset;
    }
    assert.equal(read, LONG, 'every character is readable, in parts');
    const field = await w.call('team_item', { id: '1234', field: 'Custom.Notes' });
    assert.equal(field.json.text, 'see logs');
  } finally { await w.close(); }
});

test('team_start needs askedIn and asks for a target when unmapped; team_link reports the attachments', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const refused = await w.call('team_start', { id: 'AB#1234' });
    assert.ok(refused.isError, 'askedIn is required');
    const asked = await w.call('team_start', { id: 'AB#1234', askedIn: 'm12' });
    assert.equal(asked.json.result, 'NEEDS_TARGET');
    const started = await w.call('team_start', { id: 'AB#1234', askedIn: 'm12', project: 'odeysys' });
    assert.equal(started.json.result, 'WAITING');
    const req = w.fake.requests('POST', '/teamboards/items/c1/1234/start').at(-1)!;
    assert.equal(req.headers?.['x-alfred-actor'] ?? req.headers?.['X-Alfred-Actor'], 'claude');

    const linked = await w.call('team_link', { board: 'b-refund', id: 'AB#1234' });
    assert.deepEqual(linked.json.attached, ['trace.txt']);
    assert.match(linked.json.note, /Fetch attachments/);
  } finally { await w.close(); }
});

test('team_changes and team_squads read the cache; several connections need conn', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const c = await w.call('team_changes', {});
    assert.match(c.json.changes[0], /\[7\] .* 1234 "Refund fails" · State Active → Resolved · Sara · new/);
    const s = await w.call('team_squads', {});
    assert.match(s.json.squads[0], /Payments \(Proj\) · Alfred odeysys \/ backend · members: Sara, Omar/);

    w.fake.team = team([CONN, { ...CONN, id: 'c2', name: 'Other' }]);
    const asked = await w.call('team_items', {});
    assert.match(asked.json.message, /Several connections - pass conn: c1 \(Contoso\), c2 \(Other\)/);
  } finally { await w.close(); }
});
