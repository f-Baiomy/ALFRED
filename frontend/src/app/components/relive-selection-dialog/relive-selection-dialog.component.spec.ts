import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ReliveSelectionDialogService } from '../../core/services/relive-selection-dialog.service';
import { ReliveCyclesStateService } from '../../core/state/relive-cycles-state.service';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveCycle, ReliveCycleSummary, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveSelectionDialogComponent } from './relive-selection-dialog.component';

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function recording(): FrozenCall {
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
  };
}

function step(key: string): Step {
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
    source: { callId: key, cycleId: null, direction: 'inbound' },
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
    steps: [step('s-1')],
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

function call(id: string): CallRecord {
  return {
    id,
    method: 'GET',
    url: 'https://app.local/profile',
    timestamp: '2026-09-27T10:05:00Z',
    duration_ms: 90,
    source: 'internal',
    request: { headers: {}, body: null },
    response: { status: 200, headers: {}, body: '{}' },
  } as unknown as CallRecord;
}

describe('ReliveSelectionDialogComponent', () => {
  let fixture: ComponentFixture<ReliveSelectionDialogComponent>;
  let getSpy: jasmine.Spy;
  let updateSpy: jasmine.Spy;
  const cyclesSignal = signal<readonly ReliveCycleSummary[]>([
    { id: 'c-1', name: 'Book flow', description: null, updatedAt: '2026-09-27T10:00:00Z', isTransient: false, lastRun: null, stepCount: 1, childCount: 0, liveCount: 0, cycleRuleCount: 0 },
  ]);

  beforeEach(() => {
    getSpy = jasmine.createSpy('get').and.returnValue(of(cycle()));
    updateSpy = jasmine.createSpy('update').and.returnValue(of(cycle({ updatedAt: '2026-09-27T11:00:00Z' })));
    TestBed.configureTestingModule({
      imports: [ReliveSelectionDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ReliveApiService, useValue: { get: getSpy, update: updateSpy, listVersions: () => of([]) } },
        { provide: ReliveCyclesStateService, useValue: { cycles: cyclesSignal } },
      ],
    });
    fixture = TestBed.createComponent(ReliveSelectionDialogComponent);
  });

  it('ADD mode: picking a cycle then applying appends the selection as new steps', () => {
    const service = TestBed.inject(ReliveSelectionDialogService);
    service.open([call('r-new')], 'ADD');
    fixture.detectChanges();

    fixture.componentInstance.pick(cyclesSignal()[0]);
    fixture.componentInstance.apply();

    expect(updateSpy).toHaveBeenCalled();
    const [id, body, ifMatch, reason] = updateSpy.calls.mostRecent().args;
    expect(id).toBe('c-1');
    expect(body.steps.length).toBe(2);
    expect(ifMatch).toBe('2026-09-27T10:00:00Z');
    expect(reason).toBeUndefined();
    expect(fixture.componentInstance.resultMessage()).toContain('added');
  });

  it('REPLACE mode: previews added/removed against the fresh recording, then applies with REPLACE_STEPS', () => {
    const service = TestBed.inject(ReliveSelectionDialogService);
    service.open([call('r-new')], 'REPLACE');
    fixture.detectChanges();

    fixture.componentInstance.pick(cyclesSignal()[0]);
    expect(fixture.componentInstance.preview()!.rows.some((r) => r.kind === 'added')).toBeTrue();
    expect(fixture.componentInstance.preview()!.rows.some((r) => r.kind === 'removed')).toBeTrue();

    fixture.componentInstance.apply();
    const [, , , reason] = updateSpy.calls.mostRecent().args;
    expect(reason).toBe('REPLACE_STEPS');
  });
});
