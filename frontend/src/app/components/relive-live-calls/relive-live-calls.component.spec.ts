import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AppConfigService } from '../../core/services/app-config.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ResendDialogService } from '../../core/services/resend-dialog.service';
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

  it('T074: "Mock with it" writes the live answer into the picked step\'s mock and emits it for the host to apply', () => {
    fixture.detectChanges();
    let emitted: { stepKey: string; callRule: unknown } | undefined;
    fixture.componentInstance.mockWith.subscribe((e) => (emitted = e));

    fixture.componentInstance.openMockWith(liveCall());
    expect(fixture.componentInstance.mockableSteps().map((s) => s.key)).toEqual(['s-supA']);
    fixture.componentInstance.applyMockWith('s-supA');

    expect(fixture.componentInstance.mockWithTarget()).toBeNull();
    expect(emitted?.stepKey).toBe('s-supA');
    const actions = (emitted!.callRule as { actions: { type: string; status?: number; body?: string }[] }).actions;
    const mock = actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mock?.status).toBe(500);
    expect(mock?.body).toBe('{"error":"boom"}');
  });

  it('T074: Resend hydrates the logged call via getSummary + getDetail and opens the resend dialog', () => {
    const resendDialog = TestBed.inject(ResendDialogService);
    const openSpy = spyOn(resendDialog, 'open');
    const backendUrl = TestBed.inject(AppConfigService).backendUrl;

    fixture.detectChanges();
    fixture.componentInstance.openResend(liveCall());

    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${backendUrl}/calls/call-9/summary`).flush({ id: 'call-9', original_url: 'https://api.supplier-a.com/v2/search', url: 'https://api.supplier-a.com/v2/search', method: 'POST', timestamp: 't', duration_ms: 5, status: 500 });
    http.expectOne(`${backendUrl}/calls/call-9/detail`).flush({ request: { headers: {}, body: '{}' }, response: { status: 500, headers: {}, body: '{"error":"boom"}' } });

    expect(openSpy).toHaveBeenCalledWith(jasmine.objectContaining({ id: 'call-9', method: 'POST' }), 'c-1');
  });

  it('T074: Export ▾ hydrates the logged call, then opens the export dialog with the requested format', () => {
    const exportDialog = TestBed.inject(ExportDialogService);
    const openSpy = spyOn(exportDialog, 'open');
    const backendUrl = TestBed.inject(AppConfigService).backendUrl;

    fixture.detectChanges();
    fixture.componentInstance.exportCall(liveCall(), 'json');

    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${backendUrl}/calls/call-9/summary`).flush({ id: 'call-9', original_url: 'https://api.supplier-a.com/v2/search', url: 'https://api.supplier-a.com/v2/search', method: 'POST', timestamp: 't', duration_ms: 5, status: 500 });
    http.expectOne(`${backendUrl}/calls/call-9/detail`).flush({ request: { headers: {}, body: '{}' }, response: { status: 500, headers: {}, body: '{"error":"boom"}' } });
    http.expectOne(`${backendUrl}/calls/export-metadata`).flush({});
    http.expectOne((r) => r.url === `${backendUrl}/comments`).flush([]);

    expect(openSpy).toHaveBeenCalledWith([jasmine.objectContaining({ id: 'call-9' })], jasmine.anything(), jasmine.anything(), 'json');
  });

  describe('T063: masking', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('variables', [{ name: 'token', value: 'super-secret', secret: true }]);
    });

    it('masks a secret variable\'s value in the compare preview until "Reveal secrets" is clicked', () => {
      getSpy.and.returnValue(of(liveCall({ response: { status: 500, headers: {}, body: '{"error":"super-secret rejected"}' } })));
      fixture.detectChanges();

      fixture.componentInstance.openCompare(liveCall());
      expect(fixture.componentInstance.compareData()!.finalResponse!.body).not.toContain('super-secret');
      expect(fixture.componentInstance.compareData()!.finalResponse!.body).toContain('•••');

      fixture.componentInstance.toggleReveal();
      fixture.componentInstance.comparingId.set(null);
      fixture.componentInstance.openCompare(liveCall());
      expect(fixture.componentInstance.compareData()!.finalResponse!.body).toContain('super-secret');
    });
  });
});
