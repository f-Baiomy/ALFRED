import { canonicalResponseBody, finishedResponseDifference, listResponseDifferences, responseStructureDifference } from './relive-canonical-body';
import { NoiseRule } from './relive-types';

const quiet = { noiseRules: [] as NoiseRule[], variablesUsed: [], variablesProduced: [] };

describe('response structure', () => {
  it('treats key order and whitespace as the same JSON structure', () => {
    const recorded = '{\n  "b": 1,\n  "a": { "z": true, "m": [1, 2] }\n}';
    const actual = '{"a":{"m":[1,2],"z":true},"b":1}';
    expect(canonicalResponseBody(recorded)).toBe(canonicalResponseBody(actual));
    expect(responseStructureDifference(recorded, actual)).toBeNull();
  });

  it('reports one body difference when the JSON structure differs', () => {
    const diff = responseStructureDifference('{"items":[1,2]}', '{"items":[2,1]}');
    expect(diff).toEqual({ recorded: 'recorded structure', actual: 'different structure' });
  });

  it('ignores XML attribute order and the space between elements', () => {
    const recorded = '<Search b="2" a="1">\n  <Leg>1</Leg>\n</Search>';
    const actual = '<Search a="1" b="2"><Leg>1</Leg></Search>';
    expect(responseStructureDifference(recorded, actual)).toBeNull();
  });

  it('reports one body difference when XML text differs', () => {
    expect(responseStructureDifference('<Search>1</Search>', '<Search>2</Search>')).toEqual({
      recorded: 'recorded structure',
      actual: 'different structure',
    });
  });

  it('normalizes plain-text newlines and still flags a real text change', () => {
    expect(responseStructureDifference('hello\r\nthere', 'hello\nthere')).toBeNull();
    expect(responseStructureDifference('hello', 'hello!')).toEqual({
      recorded: 'recorded structure',
      actual: 'different structure',
    });
  });
});

describe('finished response', () => {
  const recorded = {
    status: 200,
    headers: { 'Content-Type': 'application/json', Date: 'Mon', 'Set-Cookie': 'a=1', 'X-Request-Id': 'old' },
    body: '{"total":450,"traceId":"b-7c1e"}',
  };

  it('matches when only noise leaves and generated headers differ', () => {
    const actual = {
      status: 200,
      headers: { 'content-type': 'application/json', Date: 'Tue', 'Set-Cookie': 'a=2', 'X-Request-Id': 'new' },
      body: '{ "traceId": "b-99d0", "total": 450 }',
    };
    expect(finishedResponseDifference(recorded, actual, quiet)).toBeNull();
    expect(listResponseDifferences(recorded, actual, quiet)).toEqual([]);
  });

  it('emits one row when a real field differs, and does not include the bodies', () => {
    const actual = { ...recorded, body: '{"total":455,"traceId":"b-99d0"}' };
    expect(finishedResponseDifference(recorded, actual, quiet)).toEqual({
      recorded: 'recorded response',
      actual: 'different response',
    });
    expect(listResponseDifferences(recorded, actual, quiet)).toEqual([
      { part: 'body', path: 'body.total', recorded: '450', actual: '455' },
    ]);
  });

  it('emits one row for a status change inside the same class', () => {
    const actual = { ...recorded, status: 201 };
    expect(finishedResponseDifference(recorded, actual, quiet)).toEqual({
      recorded: 'recorded response',
      actual: 'different response',
    });
    expect(listResponseDifferences(recorded, actual, quiet)).toEqual([
      { part: 'status', path: 'status', recorded: '200', actual: '201' },
    ]);
  });

  it('emits one row when a stable header differs', () => {
    const actual = { ...recorded, headers: { ...recorded.headers, 'Content-Type': 'text/plain' } };
    expect(finishedResponseDifference(recorded, actual, quiet)).toEqual({
      recorded: 'recorded response',
      actual: 'different response',
    });
    expect(listResponseDifferences(recorded, actual, quiet)).toEqual([
      { part: 'header', path: 'content-type', recorded: 'application/json', actual: 'text/plain' },
    ]);
  });

  it('treats a user noise rule as a match unless count is forced', () => {
    const actual = { ...recorded, body: '{"total":455,"traceId":"b-7c1e"}' };
    const ignored: NoiseRule = { part: 'body', path: 'body.total', auto: false, count: false };
    expect(finishedResponseDifference(recorded, actual, { ...quiet, noiseRules: [ignored] })).toBeNull();
    const counted: NoiseRule = { part: 'body', path: 'body.traceId', auto: true, count: true };
    const traceOnly = { ...recorded, body: '{"total":450,"traceId":"other"}' };
    expect(finishedResponseDifference(recorded, traceOnly, { ...quiet, noiseRules: [counted] })).toEqual({
      recorded: 'recorded response',
      actual: 'different response',
    });
    expect(listResponseDifferences(recorded, actual, { ...quiet, noiseRules: [ignored] })).toEqual([]);
    expect(listResponseDifferences(recorded, traceOnly, { ...quiet, noiseRules: [counted] })).toEqual([
      { part: 'body', path: 'body.traceId', recorded: 'b-7c1e', actual: 'other' },
    ]);
  });

  it('lists an added field and skips a noise field that was only on one side', () => {
    const actual = { ...recorded, body: '{"total":450,"traceId":"b-7c1e","currency":"USD"}' };
    expect(listResponseDifferences(recorded, actual, quiet)).toEqual([
      { part: 'body', path: 'body.currency', recorded: null, actual: 'USD' },
    ]);
  });

  it('shows a missing object as one row, not every field inside it', () => {
    const before = { status: 200, headers: {}, body: '{"offers":{"abc":{"price":4450,"code":"ADT"}}}' };
    const after = { status: 200, headers: {}, body: '{"offers":{}}' };
    expect(listResponseDifferences(before, after, quiet)).toEqual([
      { part: 'body', path: 'body.offers.abc', recorded: '{"price":4450,"code":"ADT"}', actual: null },
    ]);
  });
});
