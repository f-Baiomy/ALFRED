import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { CallRecord } from '../../core/models/call.model';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { CycleVersion, FrozenCall, ReliveCycle, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveRebuildDialogComponent } from './relive-rebuild-dialog.component';

function recording(overrides: Partial<FrozenCall> = {}): FrozenCall {
  return {
    method: 'GET',
    url: 'https://app.local/search',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseHeaders: {},
    responseBody: '{}',
    timestamp: '2026-09-27T10:00:00Z',
    durationMs: 100,
    sessionId: null,
    operationId: null,
    serviceName: 'odeysys',
    source: 'inbound',
    ...overrides,
  };
}

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function inboundStep(key: string, sourceCycleId: string | null): Step {
  const rec = recording();
  return {
    key,
    parentKey: null,
    label: 'Search',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey: null, label: 'Search', recording: rec }, settings),
    unattributed: 'BLOCK',
    recording: rec,
    source: { callId: key, cycleId: sourceCycleId, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function cycle(overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps: [inboundStep('s-search', 'sc-1')],
    variables: [],
    cycleRules: [],
    globalRules: { mode: 'NONE', selectedIds: [] },
    settings,
    noise: [],
    unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
    createdAt: null,
    updatedAt: '2026-09-27T10:00:00Z',
    transient: false,
    lastRun: null,
    ...overrides,
  };
}

function call(id: string, method: string, path: string): CallRecord {
  return {
    id,
    method,
    url: `https://app.local${path}`,
    timestamp: '2026-09-27T10:05:00Z',
    duration_ms: 90,
    source: 'internal',
    session_id: null,
    operation_id: null,
    service_name: 'odeysys',
    request: { headers: {}, body: null },
    response: { status: 200, headers: {}, body: '{}' },
  } as unknown as CallRecord;
}

describe('ReliveRebuildDialogComponent', () => {
  let fixture: ComponentFixture<ReliveRebuildDialogComponent>;
  let listCallsSpy: jasmine.Spy;
  const cyclesSignal = signal([{ id: 'sc-2', name: 'Retest', createdAt: '2026-09-27T09:00:00Z', assignedTo: null, status: 'IDLE' as const }]);

  beforeEach(() => {
    listCallsSpy = jasmine.createSpy('listCalls');
    TestBed.configureTestingModule({
      imports: [ReliveRebuildDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionCyclesApiService, useValue: { listCalls: listCallsSpy } },
        { provide: SessionCyclesStateService, useValue: { cycles: cyclesSignal } },
      ],
    });
    fixture = TestBed.createComponent(ReliveRebuildDialogComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('cycle', cycle());
  });

  it('T070: Refresh is disabled when steps come from more than one source cycle', () => {
    fixture.componentRef.setInput('cycle', cycle({ steps: [inboundStep('a', 'sc-1'), { ...inboundStep('b', 'sc-2'), key: 'b' }] }));
    fixture.detectChanges();
    expect(fixture.componentInstance.refreshSourceCycleId()).toBeNull();
  });

  it('T070: Refresh previews added/updated/removed against the fresh recording and carries over config', () => {
    listCallsSpy.and.returnValue({
      subscribe: (cb: (p: unknown) => void) => cb({ calls: [{ call: call('r-new', 'GET', '/search') }, { call: call('r-extra', 'GET', '/profile') }] }),
    });
    fixture.detectChanges();
    fixture.componentInstance.chooseMode('REFRESH');

    const preview = fixture.componentInstance.preview();
    expect(preview).toBeTruthy();
    expect(preview!.reason satisfies CycleVersion['reason']).toBe('REBUILD_REFRESH');
    expect(preview!.rows.some((r) => r.kind === 'updated')).toBeTrue();
    expect(preview!.rows.some((r) => r.kind === 'added' && r.label.includes('profile'))).toBeTrue();
    // The matched step's callRule (its configuration) is carried onto the fresh step.
    const matchedFresh = preview!.newSteps.find((s) => s.recording.url.includes('/search'))!;
    expect(matchedFresh.callRule).toEqual(cycle().steps[0].callRule);
  });

  it('T070: Rebuild from a new recording previews against the picked session cycle', () => {
    listCallsSpy.and.returnValue({ subscribe: (cb: (p: unknown) => void) => cb({ calls: [{ call: call('r-new', 'GET', '/search') }] }) });
    fixture.detectChanges();
    fixture.componentInstance.chooseMode('RECORDING');
    fixture.componentInstance.pickRecordingSource('sc-2');

    expect(listCallsSpy).toHaveBeenCalled();
    expect(fixture.componentInstance.preview()!.reason).toBe('REBUILD_RECORDING');
  });

  it('T070: Start over resets every callRule to default and re-enables every step', () => {
    const edited = cycle({ steps: [{ ...inboundStep('s-search', 'sc-1'), enabled: false, callRule: { ...inboundStep('s-search', 'sc-1').callRule, actions: [{ type: 'SET_REQUEST_HEADER', name: 'X', value: 'y', enabled: true }] } }] });
    fixture.componentRef.setInput('cycle', edited);
    fixture.detectChanges();

    fixture.componentInstance.chooseMode('START_OVER');
    const preview = fixture.componentInstance.preview()!;
    expect(preview.reason).toBe('REBUILD_START_OVER');
    expect(preview.newSteps[0].enabled).toBeTrue();
    expect(preview.newSteps[0].callRule.actions.length).toBe(0);
  });

  it('T070: Apply emits the previewed steps and reason, then closes', () => {
    fixture.detectChanges();
    fixture.componentInstance.chooseMode('START_OVER');
    let emitted: { steps: readonly Step[]; reason: CycleVersion['reason'] } | null = null;
    fixture.componentInstance.rebuild.subscribe((e) => (emitted = e));
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));

    fixture.componentInstance.apply();

    expect(emitted!.reason).toBe('REBUILD_START_OVER');
    expect(closed).toBeTrue();
    expect(fixture.componentInstance.preview()).toBeNull();
  });
});
