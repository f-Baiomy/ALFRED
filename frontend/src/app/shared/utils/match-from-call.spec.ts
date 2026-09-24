import { CallRecord } from '../../core/models/call.model';
import { MatchTestKind } from '../../core/models/interception.model';
import {
  MatchForm,
  buildMatchFill,
  defaultMatchChoices,
  generalisePath,
  hostVariants,
  matchSourceOf,
  mergeTests,
  pathVariants,
  whyNotMatching,
} from './match-from-call';

const call = {
  id: 'c1',
  original_url: 'https://api.sabre.com/v2/flight/search?currency=EUR&pax=2&currency=USD',
  url: 'https://api.sabre.com/v2/flight/search?currency=EUR&pax=2&currency=USD',
  method: 'post',
  timestamp: 't',
  duration_ms: 1,
  request: {
    headers: {
      'Content-Type': 'text/xml',
      SOAPAction: '"FlightSearchRQ"',
      Authorization: 'Bearer secret',
      'Content-Length': '99',
      Host: 'api.sabre.com',
      Cookie: 'JSESSIONID=abc; theme=dark',
    },
  },
} as unknown as CallRecord;

const emptyForm: MatchForm = { source: 'both', serviceNames: [], host: '', pathContains: '', pathRegex: '', methods: [], tests: [] };

describe('match-from-call', () => {
  const source = matchSourceOf(call, 'outbound', new Set(['authorization']));

  it('reads host, path, the path with its query, method and every testable part', () => {
    expect(source.host).toBe('api.sabre.com');
    expect(source.path).toBe('/v2/flight/search');
    expect(source.pathWithQuery).toBe('/v2/flight/search?currency=EUR&pax=2&currency=USD');
    expect(source.method).toBe('POST');
    expect(source.tests.map((t) => `${t.kind}:${t.name}:${t.secret}`)).toEqual([
      'headers:Content-Type:false',
      'headers:SOAPAction:false',
      'headers:Authorization:true',
      'query:currency:false',
      'query:pax:false',
      'cookies:JSESSIONID:true',
      'cookies:theme:true',
    ]);
    // First occurrence wins, as the proxy's query lookup does.
    expect(source.tests.find((t) => t.name === 'currency')?.value).toBe('EUR');
  });

  it('keeps the project of an inbound call only', () => {
    const inbound = matchSourceOf({ ...call, service_name: 'booking' } as CallRecord, 'inbound', null);
    expect(inbound.serviceName).toBe('booking');
    expect(matchSourceOf({ ...call, service_name: 'booking' } as CallRecord, 'outbound', null).serviceName).toBeNull();
    // Inbound: host starts unchecked - the listener already says which project it is.
    expect(defaultMatchChoices(inbound).host).toBeFalse();
    expect(defaultMatchChoices(inbound).project).toBeTrue();
  });

  it('offers the exact host and *.parent, never a wildcard for an IP or a bare domain', () => {
    expect(hostVariants('api.sabre.com').map((v) => v.value)).toEqual(['api.sabre.com', '*.sabre.com']);
    expect(hostVariants('sabre.com').length).toBe(1);
    expect(hostVariants('10.0.0.12').length).toBe(1);
  });

  it('offers the whole path, each prefix and a generalised regex', () => {
    expect(pathVariants('/v2/order/88123').map((v) => v.value)).toEqual(['/v2/order/88123', '/v2/order', '/v2', '^/v\\d+/order/\\d+(?:\\?|$)']);
    expect(generalisePath('/api/users/3f2c1a9e-1b2c-4d5e-8f90-123456789abc/tokens/AB12CD34EF')).toBe(
      '^/api/users/[0-9a-fA-F-]{36}/tokens/[^/]+(?:\\?|$)'
    );
    expect(generalisePath('/a.b/(x)')).toBe('^/a\\.b/\\(x\\)(?:\\?|$)');
  });

  it('starts every test unchecked and as "equals" its value, secrets included', () => {
    const choices = defaultMatchChoices(source);
    expect(choices.tests.every((t) => !t.on)).toBeTrue();
    const auth = choices.tests.find((t) => t.name === 'Authorization')!;
    expect(auth.secret).toBeTrue();
    expect(auth.operator).toBe('EQUALS');
    expect(auth.value).toBe('Bearer secret');
    expect(choices.tests.find((t) => t.name === 'JSESSIONID')?.value).toBe('abc');
    expect(choices.tests.find((t) => t.name === 'SOAPAction')?.operator).toBe('EQUALS');
  });

  it('fills only the checked fields, and a path writes one field while clearing the other', () => {
    const choices = defaultMatchChoices(source);
    const fill = buildMatchFill(source, {
      ...choices,
      pathForm: 'regex',
      pathValue: '^/v\\d+/flight',
      method: false,
      tests: choices.tests.map((t) =>
        t.name === 'SOAPAction' ? { ...t, on: true } : t.name === 'Authorization' ? { ...t, on: true, operator: 'EXISTS' as const } : t
      ),
    });
    expect(fill).toEqual({
      source: 'outbound',
      host: 'api.sabre.com',
      pathContains: '',
      pathRegex: '^/v\\d+/flight',
      tests: [
        { kind: 'headers', name: 'SOAPAction', operator: 'EQUALS', value: '"FlightSearchRQ"' },
        { kind: 'headers', name: 'Authorization', operator: 'EXISTS', value: null },
      ],
    });
  });

  it('copies a checked secret with its value, and none once switched to "exists"', () => {
    const choices = defaultMatchChoices(source);
    const fill = buildMatchFill(source, { ...choices, tests: choices.tests.map((t) => (t.name === 'Authorization' ? { ...t, on: true } : t)) });
    expect(fill.tests).toEqual([{ kind: 'headers', name: 'Authorization', operator: 'EQUALS', value: 'Bearer secret' }]);
  });

  it('merges tests: same kind and name replaced in place (header names case-insensitive), others appended', () => {
    type Row = { kind: MatchTestKind; name: string; v: number };
    const merged = mergeTests<Row>(
      [
        { kind: 'headers' as const, name: 'soapaction', v: 1 },
        { kind: 'query' as const, name: 'mode', v: 1 },
      ],
      [
        { kind: 'headers' as const, name: 'SOAPAction', v: 2 },
        { kind: 'cookies' as const, name: 'JSESSIONID', v: 2 },
      ]
    );
    expect(merged).toEqual([
      { kind: 'headers', name: 'SOAPAction', v: 2 },
      { kind: 'query', name: 'mode', v: 1 },
      { kind: 'cookies', name: 'JSESSIONID', v: 2 },
    ]);
  });

  it('says the filled match still matches the call, and names each field once edited away', () => {
    const fill = buildMatchFill(source, defaultMatchChoices(source));
    const form: MatchForm = { ...emptyForm, ...fill, pathRegex: fill.pathRegex ?? '', pathContains: fill.pathContains ?? '', host: fill.host ?? '', methods: fill.methods ?? [], source: fill.source ?? 'both' };
    expect(whyNotMatching(form, source)).toEqual([]);

    expect(whyNotMatching({ ...form, host: '*.sabre.com' }, source)).toEqual([]);
    expect(whyNotMatching({ ...form, host: '*.amadeus.com', methods: ['GET'], source: 'inbound' }, source)).toEqual([
      'direction is inbound, the call is outbound',
      'method POST is not selected',
      'host *.amadeus.com does not match api.sabre.com',
    ]);
    // pathContains sees the query too, like the proxy's request.path.
    expect(whyNotMatching({ ...form, pathContains: 'pax=2' }, source)).toEqual([]);
    expect(whyNotMatching({ ...form, pathContains: '', pathRegex: '^/v\\d+/order' }, source)).toEqual(['path regex does not match']);
    expect(whyNotMatching({ ...form, pathContains: '', pathRegex: '(?P<v>v\\d+)' }, source)).toEqual([]);
  });

  it('checks tests the way the proxy does', () => {
    const tests = (t: MatchForm['tests'][number]) => whyNotMatching({ ...emptyForm, tests: [t] }, source);
    expect(tests({ kind: 'headers', name: 'soapaction', operator: 'EQUALS', value: '"FlightSearchRQ"' })).toEqual([]);
    expect(tests({ kind: 'headers', name: 'SOAPAction', operator: 'EQUALS', value: '"flightsearchrq"' })).toEqual(['header SOAPAction does not equal the value']);
    expect(tests({ kind: 'headers', name: 'SOAPAction', operator: 'EQUALS', value: '"flightsearchrq"', caseSensitive: false })).toEqual([]);
    expect(tests({ kind: 'headers', name: 'X-Missing', operator: 'NOT_EXISTS' })).toEqual([]);
    expect(tests({ kind: 'cookies', name: 'jsessionid', operator: 'EXISTS' })).toEqual(['cookie jsessionid is not on the call']);
    expect(tests({ kind: 'query', name: 'pax', operator: 'MATCHES', value: '^\\d$' })).toEqual([]);
    expect(tests({ kind: 'query', name: 'pax', operator: 'MATCHES', value: '(' })).toEqual(['query pax: regex could not be checked here']);
  });
});
