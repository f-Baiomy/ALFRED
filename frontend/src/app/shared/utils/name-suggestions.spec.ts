import { filterSuggestions, headerSuggestions, requestCookieSuggestions, responseCookieSuggestions } from './name-suggestions';

describe('name suggestions', () => {
  it('orders a call\'s headers most useful first: its own and auth-like, then standard, transport last', () => {
    const names = headerSuggestions({
      Connection: 'keep-alive', 'Content-Type': 'application/json', 'X-Booking-Ref': 'R-9', Authorization: 'Bearer x', Date: 'today',
    }).map((s) => s.name);
    expect(names).toEqual(['Authorization', 'X-Booking-Ref', 'Content-Type', 'Connection', 'Date']);
  });

  it('reads the cookies a request sent and the ones a response sets', () => {
    expect(requestCookieSuggestions({ Cookie: 'JSESSIONID=abc; theme=dark' })).toEqual([
      { name: 'JSESSIONID', value: 'abc' },
      { name: 'theme', value: 'dark' },
    ]);
    expect(responseCookieSuggestions({ 'Set-Cookie': 'JSESSIONID=GG1; path=/app, lang=en; Expires=Wed, 21 Oct 2026 07:28:00 GMT' })).toEqual([
      { name: 'JSESSIONID', value: 'GG1 · path=/app' },
      { name: 'lang', value: 'en' },
    ]);
  });

  it('filters by what is typed, names that start with it first', () => {
    const all = headerSuggestions({ 'X-Request-Id': '1', 'Accept': '2', 'Max-Forwards': '3' });
    expect(filterSuggestions(all, 'x-r').map((s) => s.name)).toEqual(['X-Request-Id']);
    expect(filterSuggestions(all, 'ac').map((s) => s.name)).toEqual(['Accept']);
    expect(filterSuggestions(all, '').length).toBe(3);
  });
});
