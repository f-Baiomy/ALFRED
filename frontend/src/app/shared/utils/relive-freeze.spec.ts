import { CallRecord } from '../../core/models/call.model';
import { modeOf, onRequestChangedOf } from './relive-call-rule';
import { freezeCalls } from './relive-freeze';
import { ReliveSettings } from './relive-types';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(overrides: Partial<CallRecord> & { id: string; startMs: number; durationMs: number }): CallRecord {
  const { id, startMs, durationMs, ...rest } = overrides;
  return {
    id,
    original_url: `http://localhost/${id}`,
    url: `http://api.supplier.com/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    request: { headers: { 'Content-Type': 'application/json' }, body: '{"q":1}' },
    response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' },
    source: 'internal',
    state: 'COMPLETED',
    ...rest,
  };
}

/** One inbound "Search" call wrapping 3 outbound supplier calls. */
function fixture(): CallRecord[] {
  return [
    call({ id: 'search', startMs: 0, durationMs: 900, service_name: 'odeysys' }),
    call({ id: 'supA', startMs: 10, durationMs: 300, source: 'external', service_name: 'odeysys' }),
    call({ id: 'supB', startMs: 20, durationMs: 300, source: 'external', service_name: 'odeysys' }),
    call({ id: 'supC', startMs: 30, durationMs: 300, source: 'external', service_name: 'odeysys' }),
  ];
}

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

describe('freezeCalls', () => {
  it('turns one inbound call with 3 children into 4 steps with the right parentKey', () => {
    const steps = freezeCalls(fixture(), new Map(), settings);
    expect(steps.length).toBe(4);

    const root = steps.find((s) => s.parentKey === null);
    expect(root).toBeDefined();
    expect(root!.direction).toBe('inbound');

    const children = steps.filter((s) => s.parentKey === root!.key);
    expect(children.length).toBe(3);
    expect(children.every((c) => c.direction === 'outbound')).toBeTrue();
  });

  it("each child's default call rule is REPLAY with FAIL on request differs", () => {
    const steps = freezeCalls(fixture(), new Map(), settings);
    const children = steps.filter((s) => s.parentKey !== null);
    for (const child of children) {
      expect(modeOf(child.callRule)).toBe('REPLAY');
      expect(onRequestChangedOf(child.callRule)).toBe('FAIL');
    }
  });

  it('never modifies the original recorded call - the FrozenCall is a copy', () => {
    const original = fixture();
    const steps = freezeCalls(original, new Map(), settings);
    (steps[0].recording.requestHeaders as Record<string, string>)['X-Mutated'] = 'yes';
    expect(original[0].request?.headers?.['X-Mutated']).toBeUndefined();
  });

  it('root step gets a plain label from method and path', () => {
    const steps = freezeCalls(fixture(), new Map(), settings);
    const root = steps.find((s) => s.parentKey === null)!;
    expect(root.label).toBe('POST /search');
  });

  it('uses the fuller detail from `details` when given, over the summary call', () => {
    const summary = [call({ id: 'search', startMs: 0, durationMs: 900, service_name: 'odeysys', request: undefined, response: undefined })];
    const detail = call({ id: 'search', startMs: 0, durationMs: 900, service_name: 'odeysys' });
    const steps = freezeCalls(summary, new Map([['search', detail]]), settings);
    expect(steps[0].recording.requestBody).toBe('{"q":1}');
  });
});
