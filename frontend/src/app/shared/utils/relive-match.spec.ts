import { MatchableStep, pairSteps } from './relive-match';

function step(key: string, parentKey: string | null, method: string, url: string): MatchableStep {
  return { key, parentKey, recording: { method, url } as MatchableStep['recording'] };
}

describe('pairSteps', () => {
  it('matches identical old/new lists one-to-one', () => {
    const login = step('s-login', null, 'POST', 'https://app.local/login');
    const search = step('s-search', null, 'POST', 'https://app.local/search');
    const supplierA = step('c-a', 's-search', 'GET', 'https://api.supplier-a.com/v2/fares');

    const result = pairSteps([login, search, supplierA], [login, search, supplierA]);

    expect(result.matched.length).toBe(3);
    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(0);
  });

  it('matches by endpoint + order within the same parent, not by key', () => {
    const oldSearch = step('s-search-old', null, 'POST', 'https://app.local/search');
    const newSearch = step('s-search-new', null, 'POST', 'https://app.local/search');

    const result = pairSteps([oldSearch], [newSearch]);

    expect(result.matched).toEqual([[oldSearch, newSearch]]);
    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(0);
  });

  it('pairs the Nth old occurrence of an endpoint with the Nth new occurrence, under the same parent', () => {
    const search = step('s-search', null, 'POST', 'https://app.local/search');
    const oldFirst = step('c-1', 's-search', 'GET', 'https://api.supplier.com/fares');
    const oldSecond = step('c-2', 's-search', 'GET', 'https://api.supplier.com/fares');
    const newFirst = step('c-1b', 's-search', 'GET', 'https://api.supplier.com/fares');
    const newSecond = step('c-2b', 's-search', 'GET', 'https://api.supplier.com/fares');

    const result = pairSteps([search, oldFirst, oldSecond], [search, newFirst, newSecond]);

    expect(result.matched).toContain([oldFirst, newFirst] as any);
    expect(result.matched).toContain([oldSecond, newSecond] as any);
  });

  it('marks an endpoint present only in the new recording as added, including its own children', () => {
    const search = step('s-search', null, 'POST', 'https://app.local/search');
    const supplierD = step('c-d', 's-search', 'GET', 'https://api.supplier-d.net/fares');
    const supplierDChild = step('c-d-1', 'c-d', 'GET', 'https://api.supplier-d.net/fares/detail');

    const result = pairSteps([search], [search, supplierD, supplierDChild]);

    expect(result.added).toEqual([supplierD, supplierDChild]);
    expect(result.removed.length).toBe(0);
  });

  it('marks an endpoint present only in the old recording as removed, including its own children', () => {
    const search = step('s-search', null, 'POST', 'https://app.local/search');
    const supplierC = step('c-c', 's-search', 'GET', 'https://api.supplier-c.com/fares');
    const supplierCChild = step('c-c-1', 'c-c', 'GET', 'https://api.supplier-c.com/fares/detail');

    const result = pairSteps([search, supplierC, supplierCChild], [search]);

    expect(result.removed).toEqual([supplierC, supplierCChild]);
    expect(result.added.length).toBe(0);
  });

  it('never pairs children across two parents that did not themselves match', () => {
    const oldSearch = step('s-search', null, 'POST', 'https://app.local/search');
    const newBook = step('s-book', null, 'POST', 'https://app.local/book');
    const oldChild = step('c-old', 's-search', 'GET', 'https://api.supplier.com/fares');
    const newChild = step('c-new', 's-book', 'GET', 'https://api.supplier.com/fares');

    const result = pairSteps([oldSearch, oldChild], [newBook, newChild]);

    expect(result.matched.length).toBe(0);
    expect(result.removed).toEqual([oldSearch, oldChild]);
    expect(result.added).toEqual([newBook, newChild]);
  });
});
