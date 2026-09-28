import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, LiveCall, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveLiveCallsComponent } from './relive-live-calls.component';

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function recording(): FrozenCall {
  return {
    method: 'POST',
    url: 'https://api.supplier-a.com/v2/search',
    requestHeaders: {},
    requestBody: '{}',
    status: 200,
    responseHeaders: {},
    responseBody: '{"ok":true}',
    timestamp: '2026-09-27T10:00:00Z',
    durationMs: 100,
    sessionId: null,
    operationId: null,
    serviceName: 'odeysys',
    source: 'outbound',
  };
}

function step(): Step {
  const rec = recording();
  return {
    key: 's-supA',
    parentKey: 's-search',
    label: 'Supplier A',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key: 's-supA', parentKey: 's-search', label: 'Supplier A', recording: rec }, settings),
    unattributed: 'BLOCK',
    recording: rec,
    source: { callId: 's-supA', cycleId: null, direction: 'outbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function liveCall(overrides: Partial<LiveCall> = {}): LiveCall {
  return {
    id: 'l-1',
    cycleId: 'c-1',
    runId: 'r-1',
    stepKey: 's-supA',
    reason: 'LIVE',
    loggedCallId: 'call-9',
    request: { headers: {}, body: '{}' },
    response: { status: 500, headers: {}, body: '{"error":"boom"}' },
    status: 500,
    durationMs: 77,
    at: '2026-09-27T11:00:00Z',
    ...overrides,
  };
}

describe('ReliveLiveCallsComponent', () => {
  let fixture: ComponentFixture<ReliveLiveCallsComponent>;
  let listSpy: jasmine.Spy;
  let getSpy: jasmine.Spy;
  let useAsRecordingSpy: jasmine.Spy;
  let deleteSpy: jasmine.Spy;
  let listVersionsSpy: jasmine.Spy;
  let restoreVersionSpy: jasmine.Spy;

  beforeEach(() => {
    listSpy = jasmine.createSpy('listLiveCalls').and.returnValue(of({ calls: [liveCall()], totalBytes: 1000 }));
    getSpy = jasmine.createSpy('getLiveCall').and.returnValue(of(liveCall()));
    useAsRecordingSpy = jasmine.createSpy('useAsRecording').and.returnValue(of({}));
    deleteSpy = jasmine.createSpy('deleteLiveCall').and.returnValue(of(undefined));
    listVersionsSpy = jasmine.createSpy('listVersions').and.returnValue(of([{ cycleId: 'c-1', version: 4, savedAt: 't', reason: 'USE_LIVE_CALL', definition: {} }]));
    restoreVersionSpy = jasmine.createSpy('restoreVersion').and.returnValue(of({}));

    TestBed.configureTestingModule({
      imports: [ReliveLiveCallsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ReliveApiService,
          useValue: { listLiveCalls: listSpy, getLiveCall: getSpy, useAsRecording: useAsRecordingSpy, deleteLiveCall: deleteSpy, listVersions: listVersionsSpy, restoreVersion: restoreVersionSpy },
        },
        { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    fixture = TestBed.createComponent(ReliveLiveCallsComponent);
    fixture.componentRef.setInput('cycleId', 'c-1');
    fixture.componentRef.setInput('steps', [step()]);
  });

  it('loads the live calls list and total size on init', () => {
    fixture.detectChanges();
    expect(listSpy).toHaveBeenCalledWith('c-1');
    expect(fixture.componentInstance.calls().length).toBe(1);
    expect(fixture.componentInstance.totalBytes()).toBe(1000);
  });

  it('T074: opening "Use as recording" previews recorded vs the live call', () => {
    fixture.detectChanges();
    fixture.componentInstance.openUseAsRecording(liveCall());

    const target = fixture.componentInstance.recordingTarget();
    expect(target!.preview.originalResponse!.status).toBe(200);
    expect(target!.preview.finalResponse!.status).toBe(500);
  });

  it('T074: confirming "Use as recording" applies it and offers Undo', () => {
    fixture.detectChanges();
    fixture.componentInstance.openUseAsRecording(liveCall());
    fixture.componentInstance.confirmUseAsRecording();

    expect(useAsRecordingSpy).toHaveBeenCalledWith('c-1', 'l-1', 's-supA');
    expect(fixture.componentInstance.recordingTarget()).toBeNull();
    expect(fixture.componentInstance.undo()).toEqual({ version: 4 });
  });

  it('T074: Undo restores the snapshotted version', () => {
    fixture.detectChanges();
    fixture.componentInstance.openUseAsRecording(liveCall());
    fixture.componentInstance.confirmUseAsRecording();

    fixture.componentInstance.undoUseAsRecording();

    expect(restoreVersionSpy).toHaveBeenCalledWith('c-1', 4);
    expect(fixture.componentInstance.undo()).toBeNull();
  });

  it('T074: delete asks for confirmation, then removes the call and reloads', async () => {
    fixture.detectChanges();
    await fixture.componentInstance.remove(liveCall());

    expect(deleteSpy).toHaveBeenCalledWith('c-1', 'l-1');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});
