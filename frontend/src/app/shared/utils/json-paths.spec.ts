import { describeCurrent, jsonPathIndex, jsonTypeOf, suggestPaths, valuesAt } from './json-paths';

const doc = {
  currency: 'EUR',
  passengers: [
    { type: 'ADT', age: 40 },
    { type: 'CHD', age: 6 },
  ],
  tags: ['promo', 'web'],
  price: { total: 120.5, parts: [] },
  note: null,
};

describe('json-paths', () => {
  const index = jsonPathIndex(doc);
  const byPath = new Map(index.map((e) => [e.path, e]));

  it('lists every path - [*] across all items, [0] for the first - with type, count and samples', () => {
    expect(byPath.get('currency')).toEqual(jasmine.objectContaining({ type: 'text', count: 1, samples: ['EUR'], depth: 1 }));
    expect(byPath.get('passengers')?.type).toBe('list');
    expect(byPath.get('passengers[*].type')).toEqual(jasmine.objectContaining({ type: 'text', count: 2, samples: ['ADT', 'CHD'] }));
    expect(byPath.get('passengers[0].age')?.samples).toEqual(['40']);
    expect(byPath.get('tags[*]')?.samples).toEqual(['promo', 'web']);
    expect(byPath.get('price.total')?.type).toBe('number');
    expect(byPath.get('note')?.type).toBe('null');
    expect(jsonPathIndex('not an object')).toEqual([]);
  });

  it('suggests by prefix, then by last segment, then contains, then fuzzy - [*] before [0]', () => {
    expect(suggestPaths(index, 'pass')[0].path).toBe('passengers');
    expect(suggestPaths(index, 'pass').map((e) => e.path)).toContain('passengers[*].type');
    expect(suggestPaths(index, 'type').map((e) => e.path)).toEqual(['passengers[*].type', 'passengers[0].type']);
    expect(suggestPaths(index, 'ptot').map((e) => e.path)).toContain('price.total');
    expect(suggestPaths(index, 'zzz')).toEqual([]);
    expect(suggestPaths(index, '').length).toBeGreaterThan(3);
  });

  it('reads values at a path and says what an edit replaces', () => {
    expect(valuesAt(doc, 'passengers[*].age')).toEqual([40, 6]);
    expect(valuesAt(doc, 'passengers[-1].type')).toEqual(['CHD']);
    expect(valuesAt(doc, 'missing.x')).toEqual([]);
    expect(describeCurrent(valuesAt(doc, 'currency'))).toBe('was EUR');
    expect(describeCurrent([1, 2, 3, 4])).toBe('was 1, 2, 3, … (4 items)');
    expect(describeCurrent([])).toBe('not in the call');
    expect(jsonTypeOf([])).toBe('list');
    expect(jsonTypeOf(false)).toBe('boolean');
  });
});
