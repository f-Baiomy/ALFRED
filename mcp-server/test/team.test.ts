import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

const CONN = { id: 'c1', kind: 'azure', name: 'Contoso', fetchedAt: '2026-10-17T08:00:00Z', fetchedBy: 'Sara', newChanges: 2 };
const ITEM = { conn: 'c1', extId: '1234', type: 'Bug', title: 'Refund fails', state: 'Active', assignee: 'Sara', squad: 'Payments',
  sprint: 'Proj\\Sprint 12', url: 'https://dev.azure.com/x/_workitems/edit/1234', changedAt: '2026-10-16T10:00:00Z' };
const LONG = 'x'.repeat(20_000);

function team(conns = [CONN]) {
  return (method: string, p: string[], q: URLSearchParams): [number, unknown?] | undefined => {
    if (method !== 'GET') return undefined;
    if (p[1] === 'connections' && p.length === 2) return [200, conns];
    if (p[1] === 'connections' && p[3] === 'items') return [200, { items: [ITEM], total: q.get('q') === 'refund' ? 1 : 1 }];
    if (p[1] === 'items' && p[2] === 'c1' && p[3] === '1234') {
      return [200, { item: ITEM, board: null, links: [{ toId: '99', kind: 'Parent' }], fields: [
        { key: 'System.Description', value: 'Refund throws 500', mappedTo: 'PURPOSE' },
        { key: 'Microsoft.VSTS.TCM.ReproSteps', value: LONG, mappedTo: 'STEPS' },
        { key: 'Custom.Notes', value: 'see logs', mappedTo: null },
      ] }];
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

test('team_item groups fields by seed target and never cuts one', async () => {
  const w = await world();
  try {
    w.fake.team = team();
    const r = await w.call('team_item', { id: '1234' });
    assert.deepEqual(r.json.seed.purpose, ['System.Description: Refund throws 500']);
    assert.match(r.json.seed.steps[0], /\[… 17000 more characters: team_item field "Microsoft.VSTS.TCM.ReproSteps" offset 3000\]$/);
    let read = '';
    for (let offset: number | null = 0; offset !== null;) {
      const part = await w.call('team_item', { id: '1234', field: 'Microsoft.VSTS.TCM.ReproSteps', offset });
      read += part.json.text;
      offset = part.json.nextOffset;
    }
    assert.equal(read, LONG, 'every character is readable, in parts');
    assert.deepEqual(r.json.seed.context, ['Custom.Notes: see logs']);
    assert.deepEqual(r.json.links, ['Parent → 99']);
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
