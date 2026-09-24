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

    expect(component.method()).toBe('GET');
    expect(component.url()).toBe('https://api.supplier.com/fares');
    expect(component.body()).toBe('{"a":1}');
    expect(component.headers()).toEqual([{ name: 'Accept', value: 'application/json', removed: false }]);
  });

  it('builds an edits payload with only what actually changed, and direction from the call source', () => {
    dialogService.open(CALL);
    fixture.detectChanges();

    component.method.set('POST');
    component.url.set('https://api.supplier.com/fares');
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

    component.toggleHeaderRemoved(0);
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
