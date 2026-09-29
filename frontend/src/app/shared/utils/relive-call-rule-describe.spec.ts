import { describeAction, hostCard } from './relive-call-rule-describe';
import { recordedCallPreviewOf } from './recorded-call-match';
import { defaultCallRule, setOnRequestChanged } from './relive-call-rule';
import { FrozenCall, ReliveSettings } from './relive-types';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{}',
  status: 200,
  responseHeaders: { 'Content-Type': 'application/json' },
  responseBody: '{"results":12}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 100,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const child = { key: 'c-supA', parentKey: 's-search', label: 'x', recording };

describe('describeAction', () => {
  it('summarizes a MOCK_RESPONSE with status/headers/truncated body', () => {
    const rule = defaultCallRule(child, settings);
    const mock = rule.actions.find((a) => a.type === 'MOCK_RESPONSE')!;
    const line = describeAction(mock);
    expect(line.title).toContain('Mock response');
    expect(line.detail).toContain('200');
    expect(line.detail).toContain('{"results":12}');
    expect(line.on).toBeTrue();
  });

  it('marks a disabled action as off', () => {
    const rule = defaultCallRule(child, settings);
    const mock = { ...rule.actions.find((a) => a.type === 'MOCK_RESPONSE')!, enabled: false };
    expect(describeAction(mock).on).toBeFalse();
  });

  it('describes the FAIL condition else-branch', () => {
    const rule = defaultCallRule(child, settings);
    const cond = rule.actions.find((a) => a.type === 'IF_REQUEST')!;
    const detail = describeAction(cond).detail ?? '';
    expect(detail).toContain('Mock response 502');
    expect(detail).toContain('URL, method, headers');
    const withCall = describeAction(cond, recordedCallPreviewOf(recording))?.detail ?? '';
    expect(withCall).toContain('POST https://api.supplier-a.com/v2/search');
    expect(withCall).toContain('JSON');
  });

  it('describes the LIVE (SEND_TO_HOST) else-branch', () => {
    let rule = defaultCallRule(child, settings);
    rule = setOnRequestChanged(rule, 'LIVE', 'c-supA');
    const cond = rule.actions.find((a) => a.type === 'IF_REQUEST')!;
    expect(describeAction(cond).detail).toContain('send to the real host');
  });

  it('describes a PAUSE_REQUEST hold duration', () => {
    expect(describeAction({ type: 'PAUSE_REQUEST', enabled: true, timeoutSeconds: 45 }).detail).toBe('hold up to 45 s');
  });
});

describe('hostCard', () => {
  it('is "off" when the mock alone answers', () => {
    const rule = defaultCallRule(child, settings);
    expect(hostCard(rule.actions, 'api.supplier-a.com').tone).toBe('off');
  });

  it('is "warn" when LIVE-on-differs and the mock are both present', () => {
    let rule = defaultCallRule(child, settings);
    rule = setOnRequestChanged(rule, 'LIVE', 'c-supA');
    expect(hostCard(rule.actions, 'api.supplier-a.com').tone).toBe('warn');
  });

  it('is "reaches" when nothing blocks (LIVE mode)', () => {
    const rule = defaultCallRule(child, settings);
    const liveActions = rule.actions.map((a) => (a.type === 'MOCK_RESPONSE' ? { ...a, enabled: false } : a));
    expect(hostCard(liveActions, 'api.supplier-a.com').tone).toBe('reaches');
  });
});
