import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { ResendDialogService } from '../../core/services/resend-dialog.service';
import { CallRecord } from '../../core/models/call.model';
import { ResendDialogComponent } from './resend-dialog.component';

const BACKEND = 'http://backend.test:5000';

const CALL: CallRecord = {
  id: 'c1',
  original_url: 'https://api.supplier.com/fares',
  url: 'https://api.supplier.com/fares',
  method: 'GET',
  timestamp: 't',
  duration_ms: 1,
  request: { headers: { Accept: 'application/json' }, body: '{"a":1}' },
  source: 'external',
};

describe('ResendDialogComponent', () => {
  let fixture: ComponentFixture<ResendDialogComponent>;
  let component: ResendDialogComponent;
  let http: HttpTestingController;
  let dialogService: ResendDialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ResendDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    dialogService = TestBed.inject(ResendDialogService);
    fixture = TestBed.createComponent(ResendDialogComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => http.verify());

  it('pre-fills the form from the opened call', () => {
    dialogService.open(CALL);
    fixture.detectChanges();

    const d = component.draft()!;
    expect(d.method).toBe('GET');
    expect(d.url).toBe('https://api.supplier.com/fares');
    expect(d.body).toBe('{"a":1}');
    expect(d.headers).toEqual([{ name: 'Accept', value: 'application/json', removed: false }]);
  });

  it('builds an edits payload with only what actually changed, and direction from the call source', () => {
    dialogService.open(CALL);
    fixture.detectChanges();

    component.draft.update((d) => ({ ...d!, method: 'POST' }));
    component.send();

    const req = http.expectOne(`${BACKEND}/resend`);
    expect(req.request.body.direction).toBe('outbound');
    expect(req.request.body.callId).toBe('c1');
    expect(req.request.body.edits).toEqual({ method: 'POST' });
    req.flush({ newCallId: 'n1', status: 200, durationMs: 3, sessionValuesUsed: [] });
  });

  it('a removed header is sent as null, a changed header value as the new string', () => {
    dialogService.open(CALL);
    fixture.detectChanges();

    component.draft.update((d) => ({ ...d!, headers: d!.headers.map((h) => ({ ...h, removed: true })) }));
    component.send();

    const req = http.expectOne(`${BACKEND}/resend`);
    expect(req.request.body.edits).toEqual({ headers: { Accept: null } });
    req.flush({ newCallId: 'n1', status: 200, durationMs: 3, sessionValuesUsed: [] });
  });

  it('an unedited resend sends an empty edits object', () => {
    dialogService.open(CALL);
    fixture.detectChanges();

    component.send();

    const req = http.expectOne(`${BACKEND}/resend`);
    expect(req.request.body.edits).toEqual({});
    req.flush({ newCallId: 'n1', status: 200, durationMs: 3, sessionValuesUsed: [] });
  });

  it('resends a cycle copy with its cycle, and never sends a reformatted SOAP body as an edit', () => {
    const soap = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Q>1</Q></soap:Body></soap:Envelope>';
    dialogService.open({ ...CALL, request: { headers: { SOAPAction: '"Q"' }, body: soap } }, 'cy1');
    fixture.detectChanges();

    component.draft.update((d) => ({ ...d!, body: soap.replace(/></g, '>\n  <') }));
    component.send();

    const req = http.expectOne(`${BACKEND}/resend`);
    expect(req.request.body.cycleId).toBe('cy1');
    expect(req.request.body.edits).toEqual({});
    req.flush({ newCallId: 'n1', status: 200, durationMs: 3, sessionValuesUsed: [] });
  });

  it('shows the result once the resend succeeds', () => {
    dialogService.open(CALL);
    fixture.detectChanges();
    component.send();

    http.expectOne(`${BACKEND}/resend`).flush({
      newCallId: 'n1', status: 201, durationMs: 42, sessionValuesUsed: [{ name: 'Cookie', fromCallId: 'c9' }],
    });

    expect(component.result()?.status).toBe(201);
    expect(component.result()?.sessionValuesUsed).toEqual([{ name: 'Cookie', fromCallId: 'c9' }]);
  });

  it('maps a 409 to a reverse-proxy message', () => {
    dialogService.open(CALL);
    fixture.detectChanges();
    component.send();

    http.expectOne(`${BACKEND}/resend`).flush({ error: 'reverse-proxy-not-running' }, { status: 409, statusText: 'Conflict' });

    expect(component.error()).toContain('reverse-proxy');
  });
});
