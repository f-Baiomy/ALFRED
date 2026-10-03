import { applyStepChains, detectStepChains, recordedValueOf, removeStepChains } from './relive-chains';
import { FrozenCall, Step } from './relive-types';

function step(key: string, recording: Partial<FrozenCall>, extra: Partial<Step> = {}): Step {
  return {
    key,
    parentKey: null,
    label: key,
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: { name: key, enabled: true, priority: 0, match: {}, actions: [] } as unknown as Step['callRule'],
    unattributed: 'BLOCK',
    recording: {
      method: 'GET',
      url: `http://localhost:8080/${key}`,
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: '',
      timestamp: 't',
      durationMs: 1,
      source: 'inbound',
      ...recording,
    },
    source: { callId: key, cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...extra,
  };
}

describe('relive-chains', () => {
  const login = step('login', {
    method: 'POST',
    requestHeaders: { 'X-Api-Key': 'static-key-0001' },
    responseHeaders: { 'Set-Cookie': 'JSESSIONID=SESS-4455667788; Path=/', 'X-CSRF-Token': 'csrf-token-77' },
    responseBody: '{"data":{"accessToken":"tok-abcdef123","count":3}}',
  });
  const home = step('home', {
    requestHeaders: { Cookie: 'JSESSIONID=SESS-4455667788', Authorization: 'Bearer tok-abcdef123', 'X-Api-Key': 'static-key-0001' },
  });
  const save = step('save', {
    method: 'POST',
    requestHeaders: { 'X-CSRF-Token': 'csrf-token-77' },
    requestBody: 'a=1&token=tok-abcdef123',
  });

  it('finds the cookie, token and header a later step sends again, most used first', () => {
    const chains = detectStepChains([login, home, save]);

    expect(chains.map((c) => [c.kind, c.path, c.uses.length])).toEqual([
      ['JSON', 'data.accessToken', 2],
      ['COOKIE', 'JSESSIONID', 1],
      ['HEADER', 'X-CSRF-Token', 1],
    ]);
    expect(chains[0]).toEqual(
      jasmine.objectContaining({ name: 'accessToken', fromStepKey: 'login', recordedValue: 'tok-abcdef123', cookie: false, applied: false }),
    );
    expect(chains[0].uses).toEqual([
      { stepKey: 'home', where: 'Authorization' },
      { stepKey: 'save', where: 'body' },
    ]);
    expect(chains[1].cookie).toBeTrue();
  });

  it('leaves out configuration the first request already carried, short values, and disabled steps', () => {
    const chains = detectStepChains([login, home, { ...save, enabled: false }]);

    expect(chains.some((c) => c.recordedValue === 'static-key-0001')).toBeFalse();
    expect(chains.some((c) => c.kind === 'HEADER')).toBeFalse();
  });

  it('finds a value in a SOAP response by its element path', () => {
    const soapLogin = step('login', {
      responseBody: '<Envelope><Body><LoginResponse><SessionId>soap-sess-0099</SessionId></LoginResponse></Body></Envelope>',
    });
    const search = step('search', { requestBody: '<Envelope><Header><SessionId>soap-sess-0099</SessionId></Header></Envelope>' });

    expect(detectStepChains([soapLogin, search]).map((c) => [c.kind, c.path, c.name])).toEqual([['XML', 'LoginResponse.SessionId', 'SessionId']]);
  });

  it('using a chain adds an extraction that remembers the recorded value, and then reads as applied', () => {
    const chains = detectStepChains([login, home, save]);

    const steps = applyStepChains([login, home, save], [chains[0]]);

    expect(steps[0].extract).toEqual([{ from: 'JSON', path: 'data.accessToken', as: 'accessToken', missing: 'SKIP', recordedValue: 'tok-abcdef123' }]);
    expect(steps[1]).toBe(home);
    expect(detectStepChains(steps)[0].applied).toBeTrue();
  });

  it('counts a body value sent back only inside a cookie as carried by that cookie', () => {
    const odeysysLogin = step('login', {
      responseHeaders: { 'Set-Cookie': 'JSESSIONID=80S5Pej5VUBBH6k4.laptop-34bnetr7; Path=/' },
      responseBody: '{"sessionId":"80S5Pej5VUBBH6k4"}',
    });
    const details = step('details', { requestHeaders: { Cookie: 'JSESSIONID=80S5Pej5VUBBH6k4.laptop-34bnetr7' } });

    expect(detectStepChains([odeysysLogin, details]).map((c) => [c.kind, c.cookie])).toEqual([
      ['COOKIE', true],
      ['JSON', true],
    ]);
  });

  it('leaves out reference data that only repeats between steps - menu keys, names with spaces', () => {
    const menu = step('menu', { responseBody: '[{"key":"userManagement","name":"Cairo International Airport"}]' });
    const later = step('later', { requestBody: '{"key":"userManagement","airport":"Cairo International Airport"}' });

    expect(detectStepChains([menu, later])).toEqual([]);
  });

  it('keeps listing a value already in use that detection would not suggest, so it can be unticked', () => {
    const menu = step('menu', { responseBody: '[{"key":"userManagement"}]' }, {
      extract: [{ from: 'JSON', path: '[0].key', as: 'key_3', missing: 'SKIP', recordedValue: 'userManagement' }],
    });
    const later = step('later', { requestBody: '{"key":"userManagement"}' });

    expect(detectStepChains([menu, later])).toEqual([jasmine.objectContaining({ name: 'key_3', applied: true, uses: [{ stepKey: 'later', where: 'body' }] })]);
  });

  it('removing a chain drops the extraction, or only its swap when a step names the variable', () => {
    const chains = detectStepChains([login, home, save]);
    const used = applyStepChains([login, home, save], chains);

    expect(removeStepChains(used, chains)[0].extract).toEqual([]);

    const named = [used[0], { ...home, recording: { ...home.recording, url: 'http://localhost:8080/x/{{$.accessToken}}' } }, save];
    expect(removeStepChains(named, [chains[0]])[0].extract.find((r) => r.as === 'accessToken')).toEqual(
      { from: 'JSON', path: 'data.accessToken', as: 'accessToken', missing: 'SKIP' });
  });

  it('picks a name not taken by a cycle variable', () => {
    expect(detectStepChains([login, home, save], ['accessToken'])[0].name).toBe('accessToken_2');
  });

  it('re-reads the recorded value for an extraction pointed somewhere else', () => {
    expect(recordedValueOf(login, { from: 'HEADER', path: 'X-CSRF-Token', as: 'x', missing: 'SKIP' })).toBe('csrf-token-77');
    expect(recordedValueOf(login, { from: 'JSON', path: 'data.count', as: 'x', missing: 'SKIP' })).toBeUndefined();
  });
});
