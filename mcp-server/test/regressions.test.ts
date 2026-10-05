import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { CYCLE, IN1, OUT1 } from './fixtures.ts';

// Bug report 2026-10-05, bug 1: a part answered with `body: null` wiped a body fetched by another part.
test('every way of reading a body gives the same body (fields, paths, get_call_body, search_calls)', async () => {
  const w = await world();
  try {
    for (const [id, direction] of [[IN1, 'inbound'], [OUT1, 'outbound']] as const) {
      const record = w.fake.state.calls.find((c) => c.record.id === id)!.record;
      for (const side of ['request', 'response'] as const) {
        const expected = record[side]!.body!;
        const viaField = await w.call('get_call', { id, direction, fields: [`${side}Body`, `${side}Headers`, 'parentCallId'] });
        assert.equal(viaField.json[`${side}Body`].text, expected, `${id} fields ${side}Body`);
        assert.equal(viaField.json[`${side}Body`].totalLength, expected.length);
        const viaPath = await w.call('get_call', { id, direction, paths: [`${side}.body`] });
        assert.equal(viaPath.json[`${side}.body`], expected, `${id} paths ${side}.body`);
        const viaBody = await w.call('get_call_body', { id, direction, part: `${side}-body`, pretty: false });
        assert.equal(viaBody.json.text, expected, `${id} get_call_body`);
        const viaFull = await w.call('get_call', { id, direction });
        assert.equal(viaFull.json[side].body.text, expected, `${id} full`);
      }
      const viaSearch = await w.call('search_calls', { direction, text: id === IN1 ? 'CAI' : 'offers', fields: ['id', 'requestBody', 'responseBody'], limit: 50 });
      const row = viaSearch.json.calls.find((c: { id: string }) => c.id === id);
      assert.equal(row.requestBody.text, record.request!.body);
      assert.equal(row.responseBody.text, record.response!.body);
    }
  } finally { await w.close(); }
});

// Bug report 2026-10-05, bug 2: get_cycle reported db and children as missing.
test('get_cycle returns children and db when asked, not missing', async () => {
  const w = await world();
  try {
    const r = await w.call('get_cycle', { cycle: CYCLE, fields: ['id', 'children', 'db'] });
    assert.ok(!r.text.includes('missing'), r.text);
    const line = r.text.split('\n').find((l) => l.includes(`"id":"${IN1}"`))!;
    assert.match(line, /"children":\[\{"id":"out-sabre-search/);
    assert.match(line, /"db":\{"summary"/);
  } finally { await w.close(); }
});
