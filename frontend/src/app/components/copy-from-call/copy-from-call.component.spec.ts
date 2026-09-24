import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { CopyResult } from '../../shared/utils/copy-from-call';
import { CopyFromCallComponent } from './copy-from-call.component';

const BACKEND = 'http://backend.test:5000';

describe('CopyFromCallComponent', () => {
  let fixture: ComponentFixture<CopyFromCallComponent>;
  let component: CopyFromCallComponent;
  let http: HttpTestingController;
  let applied: CopyResult[];

  const summary = { id: 'c1', original_url: 'https://api.supplier.com/soap', url: 'https://api.supplier.com/soap', method: 'POST', timestamp: 't', duration_ms: 1, status: 200 };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CopyFromCallComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CopyFromCallComponent);
    component = fixture.componentInstance;
    applied = [];
    component.applied.subscribe((r) => applied.push(r));
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  /** Everything the interception state loads on first injection - irrelevant here. */
  function flushState(): void {
    for (const url of ['rules', 'paused', 'enabled', 'sensitive-headers', 'action-types']) {
      http.match(`${BACKEND}/interception/${url}`).forEach((r) => r.flush(url === 'sensitive-headers' ? { names: ['authorization'] } : url === 'enabled' ? { enabled: true } : []));
    }
  }

  it('finds a call, then copies the ticked parts of its request - secrets unticked', fakeAsync(() => {
    fixture.componentRef.setInput('target', 'request-body');
    fixture.detectChanges();
    flushState();
    tick(300);
    http.expectOne((r) => r.url === `${BACKEND}/calls`).flush({ calls: [summary], total: 1 });

    component.onChosen({ call: { ...summary, response: { status: 200 } } as never, direction: 'outbound' });
    http.expectOne(`${BACKEND}/calls/c1/detail`).flush({
      request: { headers: { 'Content-Type': 'text/xml', SOAPAction: '"Q"', Authorization: 'Bearer x', 'Content-Length': '9' }, body: '<Q>EUR</Q>' },
      response: { status: 200 },
    });

    expect(component.choices()?.headers['Authorization']).toBeFalse();
    expect(component.source()?.skipped).toEqual(['Content-Length']);
    component.apply();
    expect(applied[0].patch).toEqual({ body: '<Q>EUR</Q>', contentType: 'text/xml' });
    expect(applied[0].extra).toEqual([{ type: 'SET_REQUEST_HEADER', name: 'SOAPAction', value: '"Q"' }]);
  }));

  it('opens straight at "choose what to copy" for a call picked on another tab - from its cycle', () => {
    fixture.componentRef.setInput('target', 'response-whole');
    fixture.componentRef.setInput('preload', { ref: { source: 'external', callId: 'c1', cycleId: 'cy1' }, call: summary });
    fixture.detectChanges();
    flushState();
    http.expectOne(`${BACKEND}/session-cycles/cy1/calls/c1/detail`).flush({ request: {}, response: { status: 503, headers: { 'Retry-After': '5' }, body: 'busy' } });

    component.apply();
    expect(applied[0].patch).toEqual({ body: 'busy', status: 503, headers: { 'Retry-After': '5' } });
    expect(applied[0].extra).toEqual([]);
  });
});
