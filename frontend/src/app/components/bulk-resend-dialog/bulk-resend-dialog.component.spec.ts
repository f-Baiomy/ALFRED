import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CallRecord } from '../../core/models/call.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { CallPickerService } from '../../core/services/call-picker.service';
import { draftFrom, editsOf } from '../../shared/utils/resend-draft';
import { BulkResendDialogComponent } from './bulk-resend-dialog.component';

const BACKEND = 'http://backend.test:5000';

describe('BulkResendDialogComponent', () => {
  let fixture: ComponentFixture<BulkResendDialogComponent>;
  let component: BulkResendDialogComponent;
  let service: BulkResendDialogService;
  let http: HttpTestingController;

  const call = (id: string, source: 'external' | 'internal' = 'external'): CallRecord => ({
    id,
    original_url: `https://api.supplier.com/${id}?cur=EUR`,
    url: `https://api.supplier.com/${id}?cur=EUR`,
    method: 'GET',
    timestamp: 't',
    duration_ms: 1,
    source,
    request: { headers: { Authorization: 'Bearer old' }, body: '{"cur":"EUR"}' },
  });

  const input = (value: string) => ({ target: { value } }) as unknown as Event;

  beforeEach(() => {
    sessionStorage.removeItem('alfred_call_picker');
    TestBed.configureTestingModule({
      imports: [BulkResendDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
        { provide: Router, useValue: { url: '/', navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(BulkResendDialogService);
    service.start([draftFrom(call('a'), null), draftFrom(call('b', 'internal'), 'cy1')]);
    fixture = TestBed.createComponent(BulkResendDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    sessionStorage.removeItem('alfred_call_picker');
  });

  it('sets a header on every ticked call, and leaves unticked ones alone', () => {
    component.toggleInclude(service.drafts()[1], { target: { checked: false }, stopPropagation: () => {} } as unknown as Event);
    component.text(component.headerName.set, input('Authorization'));
    component.text(component.headerValue.set, input('Bearer new'));
    component.setHeader();

    expect(editsOf(service.drafts()[0]).headers).toEqual({ Authorization: 'Bearer new' });
    expect(editsOf(service.drafts()[1])).toEqual({});
  });

  it('counts, then replaces across URL and body; plain mode keeps $1 literal', () => {
    component.text(component.find.set, input('EUR'));
    expect(component.matchCount()).toBe(4);
    component.text(component.replace.set, input('USD$1'));
    component.replaceAll();
    expect(service.drafts()[0].url).toContain('cur=USD$1');
    expect(service.drafts()[1].body).toBe('{"cur":"USD$1"}');
  });

  it('flags a bad regex and replaces nothing', () => {
    component.checked(component.regex.set, { target: { checked: true } } as unknown as Event);
    component.text(component.find.set, input('('));
    expect(component.findError()).toBeTruthy();
    expect(component.matchCount()).toBeNull();
  });

  it('moves the host of outbound calls only, and says how many were left alone', () => {
    component.text(component.host.set, input('api.staging.supplier.com'));
    component.applyMethodAndHost();
    expect(service.drafts()[0].url).toContain('api.staging.supplier.com');
    expect(service.drafts()[1].url).toContain('api.supplier.com');
    expect(component.notice()).toContain('1 inbound left alone');
  });

  it('sends through the service with the chosen options', () => {
    const spy = spyOn(service, 'send');
    component.checked(component.stopOnFailure.set, { target: { checked: false } } as unknown as Event);
    component.onDelay(input('250'));
    component.send();
    expect(spy).toHaveBeenCalledWith({ stopOnFailure: false, delayMs: 250 });
  });

  it('hides while picking more calls, refusing ones already in the batch, and appends the picks on Return', () => {
    const picker = TestBed.inject(CallPickerService);
    component.addFromAnywhere();
    expect(service.visible()).toBeFalse();
    expect(picker.refusal(call('a'), null)).toBe('Already in this resend');

    picker.toggle(call('c'), null, 'Live calls');
    picker.finish();
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/calls/c/detail`).flush({ request: { headers: {}, body: '' } });

    expect(service.visible()).toBeTrue();
    expect(service.drafts().map((d) => d.ref.callId)).toEqual(['a', 'b', 'c']);
  });
});
