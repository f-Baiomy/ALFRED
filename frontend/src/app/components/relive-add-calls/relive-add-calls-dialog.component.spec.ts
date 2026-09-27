import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import { CapturedCall } from '../../core/models/call.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveAddCallsDialogComponent } from './relive-add-calls-dialog.component';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(overrides: Partial<CallRecord> & { id: string; startMs: number; durationMs?: number }): CallRecord {
  const { id, startMs, durationMs, ...rest } = overrides;
  return {
    id,
    original_url: `http://localhost/${id}`,
    url: `http://api.supplier.com/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs ?? 100,
    request: { headers: {}, body: '{}' },
    response: { status: 200, headers: {}, body: '{}' },
    source: 'internal',
    state: 'COMPLETED',
    ...rest,
  };
}

function captured(c: CallRecord): CapturedCall {
  return { id: c.id, capturedAt: c.timestamp, call: c };
}

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

describe('ReliveAddCallsDialogComponent', () => {
  let fixture: ComponentFixture<ReliveAddCallsDialogComponent>;
  let api: SessionCyclesApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReliveAddCallsDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
        { provide: SessionCyclesStateService, useValue: { cycles: () => [] } },
      ],
    });
    fixture = TestBed.createComponent(ReliveAddCallsDialogComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('cycleId', 'c-1');
    fixture.componentRef.setInput('settings', settings);
    api = TestBed.inject(SessionCyclesApiService);
  });

  it('lists the session cycle\'s calls as a tree, root calls only checkable', () => {
    const root = call({ id: 'search', startMs: 0, durationMs: 900, service_name: 'odeysys' });
    const child = call({ id: 'supA', startMs: 10, source: 'external', service_name: 'odeysys' });
    spyOn(api, 'listCalls').and.returnValue(of({ calls: [captured(root), captured(child)], total: 2 }));

    fixture.componentInstance.selectSessionCycle('sc-1');
    fixture.detectChanges();

    expect(fixture.componentInstance.tree().length).toBe(1);
    expect(fixture.componentInstance.tree()[0].children.length).toBe(1);
  });

  it('confirm() freezes only the checked roots (with their children) and emits steps', (done) => {
    const root = call({ id: 'search', startMs: 0, durationMs: 900, service_name: 'odeysys' });
    const child = call({ id: 'supA', startMs: 10, source: 'external', service_name: 'odeysys' });
    spyOn(api, 'listCalls').and.returnValue(of({ calls: [captured(root), captured(child)], total: 2 }));

    fixture.componentInstance.selectSessionCycle('sc-1');
    fixture.componentInstance.toggleRoot('search');

    fixture.componentInstance.added.subscribe((steps: readonly Step[]) => {
      expect(steps.length).toBe(2);
      expect(steps.find((s) => s.parentKey === null)).toBeDefined();
      done();
    });
    fixture.componentInstance.confirm();
  });

  it('confirm() closes the dialog', () => {
    const closedSpy = jasmine.createSpy('closed');
    fixture.componentInstance.closed.subscribe(closedSpy);
    fixture.componentInstance.confirm();
    expect(closedSpy).toHaveBeenCalled();
  });
});
