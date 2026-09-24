import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CallRecord } from '../../core/models/call.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { signal } from '@angular/core';
import { ResendPanelComponent } from './resend-panel.component';

const BACKEND = 'http://backend.test:5000';

describe('ResendPanelComponent', () => {
  let fixture: ComponentFixture<ResendPanelComponent>;
  let component: ResendPanelComponent;
  let http: HttpTestingController;

  const resent = (edits: Record<string, unknown>): CallRecord => ({
    id: 'new-1',
    original_url: 'https://api.staging.supplier.com/v2/fares',
    url: 'https://api.staging.supplier.com/v2/fares',
    method: 'POST',
    timestamp: '2026-09-24T19:00:00Z',
    duration_ms: 142,
    source: 'external',
    response: { status: 409 },
    resendOf: 'orig-1',
    resendEdits: edits,
  });

  function create(call: CallRecord): void {
    TestBed.configureTestingModule({
      imports: [ResendPanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
        { provide: SessionCyclesStateService, useValue: { cycles: signal([{ id: 'cy1', name: 'checkout-bug' }]) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ResendPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('call', call);
    fixture.detectChanges();
  }

  afterEach(() => http.verify());

  const originalSummary = { id: 'orig-1', original_url: 'u', url: 'https://api.supplier.com/v2/fares', method: 'POST', timestamp: 't0', duration_ms: 611, status: 200 };

  it('summarizes the request changes in the head without fetching anything', () => {
    create(resent({ url: { from: 'https://api.supplier.com/v2/fares', to: 'https://api.staging.supplier.com/v2/fares' }, headers: ['X-Env', 'X-Bulk'], body: true, origin: { direction: 'outbound', cycleId: null }, batch: { id: 'b', index: 2, total: 4 } }));
    expect(component.headSummary()).toBe('3 changes: URL · 2 headers · body');
    expect(component.originLabel()).toBe('a Live Calls call');
    expect(component.batchLabel()).toBe('2 of 4 in batch');
    http.expectNone(() => true);
  });

  it('on open, loads the original from the live log and both details, then compares the responses', () => {
    create(resent({ url: { from: 'https://api.supplier.com/v2/fares', to: 'x' }, origin: { direction: 'outbound', cycleId: null } }));
    component.toggle();

    http.expectOne((r) => r.url === `${BACKEND}/calls` && r.params.get('requestId') === 'orig-1').flush({ calls: [originalSummary], total: 1 });
    http.expectOne(`${BACKEND}/calls/orig-1/detail`).flush({ request: { headers: { A: '1' }, body: '{"c":"EUR"}' }, response: { status: 200, headers: {}, body: '{"price":1}' } });
    http.expectOne(`${BACKEND}/calls/new-1/detail`).flush({ request: { headers: { A: '2' }, body: '{"c":"USD"}' }, response: { status: 409, headers: {}, body: '{"error":"x"}' } });

    expect(component.originalRequest()?.url).toBe('https://api.supplier.com/v2/fares');
    expect(component.responseChange()).toContain('200 → 409');
    expect(component.responseChange()).toContain('body differs');
    expect(component.steps().find((s) => s.key === 'response')?.line).toBe('409 · was 200');
  });

  it("looks for a cycle copy's original in that cycle, and names it", () => {
    create(resent({ origin: { direction: 'inbound', cycleId: 'cy1' } }));
    expect(component.originLabel()).toBe('cycle "checkout-bug"');
    component.toggle();

    http.expectOne((r) => r.url === `${BACKEND}/session-cycles/cy1/internal-calls` && r.params.get('requestId') === 'orig-1').flush({ calls: [], total: 0 });
    http.expectOne(`${BACKEND}/session-cycles/cy1/internal-calls/orig-1/detail`).flush({ request: {}, response: { status: 200 } });
    http.expectOne(`${BACKEND}/calls/new-1/detail`).flush({ request: {}, response: { status: 409 } });
    expect(component.originalGone()).toBeFalse();
  });

  it('says the original is gone, and still shows the steps', () => {
    create(resent({}));
    component.toggle();
    http.expectOne((r) => r.url === `${BACKEND}/calls`).flush({ calls: [], total: 0 });
    http.expectOne(`${BACKEND}/calls/orig-1/detail`).flush({}, { status: 404, statusText: 'Not Found' });
    http.expectOne(`${BACKEND}/calls/new-1/detail`).flush({ request: {}, response: { status: 409 } });
    fixture.detectChanges();

    expect(component.originalGone()).toBeTrue();
    expect(component.steps().length).toBe(7);
    expect(fixture.nativeElement.textContent).toContain('no longer available');
  });
});
