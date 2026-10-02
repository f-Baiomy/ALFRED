import { LogEntry, Step } from './relive-types';
import { buildRunLog, runLogOffset } from './relive-run-log';

const APP = 'http://host.docker.internal:9001/odeysysadmin/Admin2';

function step(key: string, url: string, extra: Partial<Step> = {}): Step {
  return {
    key,
    label: key,
    direction: 'inbound',
    enabled: true,
    recording: { method: 'GET', url, status: 200 },
    ...extra,
  } as unknown as Step;
}

function entry(at: string, kind: LogEntry['kind'], message: string, stepKey: string | null = null): LogEntry {
  return { at, kind, message, stepKey };
}

describe('buildRunLog', () => {
  const login = step('login', `${APP}/loginAction`, { recording: { method: 'POST', url: `${APP}/loginAction`, status: 200 } } as Partial<Step>);
  const roles = step('roles', `${APP}/userRolePermission`);

  it('merges the page line and the proxy line of one attempt into one row, in time order', () => {
    // As stored: the page's SENT line is appended before the proxy line that happened earlier.
    const rows = buildRunLog(
      [
        entry('2026-10-02T16:16:19.967Z', 'SENT', 'Attempt 1: COMPLETED', 'login'),
        entry('2026-10-02T16:16:19.634926+00:00', 'FORWARDED_LIVE', `inbound POST ${APP}/loginAction (header, 200)`, 'login'),
        entry('2026-10-02T16:16:24.392Z', 'SENT', 'Attempt 1: COMPLETED_WITH_DIFFERENCES', 'roles'),
        entry('2026-10-02T16:16:24.347976+00:00', 'FORWARDED_LIVE', `inbound GET ${APP}/userRolePermission (header, 200)`, 'roles'),
      ],
      [login, roles]
    );

    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(jasmine.objectContaining({
      stepKey: 'login',
      method: 'POST',
      target: '/odeysysadmin/Admin2/loginAction',
      direction: 'inbound',
      answeredBy: 'LIVE',
      status: 200,
      attempt: 1,
      outcome: { kind: 'ok', label: '✓ OK' },
      at: '2026-10-02T16:16:19.634926+00:00',
    }));
    expect(rows[0].events[0]).toEqual({ icon: '🔗', label: 'Matched', text: 'by the ALFRED run header' });
    expect(rows[1].outcome?.kind).toBe('diff');
    expect(rows[1].tags).toContain('problem');
  });

  it('keeps each attempt of a repeated step as its own row', () => {
    const rows = buildRunLog(
      [
        entry('2026-10-02T10:00:01Z', 'REPLAYED', `inbound GET ${APP}/userRolePermission (header, 200)`, 'roles'),
        entry('2026-10-02T10:00:02Z', 'ERROR', 'Attempt 1: FAILED - status 502', 'roles'),
        entry('2026-10-02T10:00:05Z', 'FORWARDED_LIVE', `inbound GET ${APP}/userRolePermission (header, 200)`, 'roles'),
        entry('2026-10-02T10:00:06Z', 'SENT', 'Attempt 2: COMPLETED', 'roles'),
      ],
      [roles]
    );

    expect(rows.map((r) => [r.attempt, r.answeredBy, r.outcome?.kind])).toEqual([
      [1, 'REPLAYED', 'fail'],
      [2, 'LIVE', 'ok'],
    ]);
    expect(rows[0].events).toContain({ icon: '✗', label: 'Error', text: 'status 502' });
  });

  it('puts rules, request changes and a variable set after the step on that attempt, and tags them', () => {
    const rows = buildRunLog(
      [
        entry('2026-10-02T10:00:01Z', 'FORWARDED_LIVE', `inbound POST ${APP}/loginAction (operation_id, 200)`, 'login'),
        entry('2026-10-02T10:00:01Z', 'REQUEST_CHANGED', `POST ${APP}/loginAction differs from the recording`, 'login'),
        entry('2026-10-02T10:00:01Z', 'RULE_APPLIED', 'CYCLE rule "Ignore timestamps"', 'login'),
        entry('2026-10-02T10:00:02Z', 'SENT', 'Attempt 1: COMPLETED', 'login'),
        entry('2026-10-02T10:00:02.100Z', 'VARIABLE_SET', '{{$.token}} set by this step', 'login'),
      ],
      [login]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].events.map((e) => e.label)).toEqual(['Matched', 'Request changed', 'Rule applied', 'Variable set']);
    expect(rows[0].tags).toEqual(jasmine.arrayWithExactContents(['rule', 'var']));
  });

  it('nests an outbound child step under the parent attempt it ran in, showing the supplier host', () => {
    const search = step('search', `${APP}/search`);
    const supplier = step('supplier', 'https://supplier-b.example/api/search', {
      parentKey: 'search',
      direction: 'outbound',
    } as Partial<Step>);
    const rows = buildRunLog(
      [
        entry('2026-10-02T10:00:01Z', 'FORWARDED_LIVE', `inbound GET ${APP}/search (header, 200)`, 'search'),
        entry('2026-10-02T10:00:01.400Z', 'BLOCKED', 'outbound POST https://supplier-b.example/api/search (inflight)', 'supplier'),
        entry('2026-10-02T10:00:02Z', 'SENT', 'Attempt 1: COMPLETED', 'search'),
      ],
      [search, supplier]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].children.length).toBe(1);
    expect(rows[0].children[0]).toEqual(jasmine.objectContaining({
      target: 'supplier-b.example/api/search',
      direction: 'outbound',
      answeredBy: 'BLOCKED',
      status: null,
      outcome: { kind: 'fail', label: '✗ blocked' },
    }));
    // The parent row carries its child's problem so the Problems filter finds it.
    expect(rows[0].tags).toContain('problem');
  });

  it('shows run-level lines and unexpected calls as their own rows', () => {
    const rows = buildRunLog(
      [
        entry('2026-10-02T10:00:03Z', 'UNEXPECTED_CALL', 'GET https://cdn.example/collect matched no step - sent to the real system'),
        entry('2026-10-02T10:00:01Z', 'DEFINITION_UPDATED', 'Cycle edited during the run'),
        entry('2026-10-02T10:00:02Z', 'AMBIGUOUS_BLOCKED', 'Call c-1 matched more than one active run and was blocked.'),
      ],
      [login]
    );

    expect(rows.map((r) => r.outcome?.label)).toEqual(['✎ cycle edited', '✗ blocked', '⚠ unexpected']);
    expect(rows[2]).toEqual(jasmine.objectContaining({ method: 'GET', target: 'cdn.example/collect', answeredBy: 'LIVE' }));
    expect(rows[1].tags).toEqual(['problem']);
  });

  it('keeps a line it cannot parse readable instead of dropping it', () => {
    const rows = buildRunLog([entry('2026-10-02T10:00:01Z', 'SENT', 'something new', 'login')], [login]);

    expect(rows.length).toBe(1);
    expect(rows[0].target).toBe('/odeysysadmin/Admin2/loginAction');
    expect(rows[0].events).toContain({ icon: '•', label: 'Sent', text: 'something new' });
  });
});

describe('runLogOffset', () => {
  it('shows seconds under a minute, minutes and seconds above', () => {
    const start = Date.parse('2026-10-02T10:00:00Z');
    expect(runLogOffset(start + 4700, start)).toBe('+4.7s');
    expect(runLogOffset(start + 65_000, start)).toBe('+1m 05s');
    expect(runLogOffset(NaN, start)).toBe('');
  });
});
