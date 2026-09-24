import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { AnswerPickerComponent } from './answer-picker.component';

const BACKEND = 'http://backend.test:5000';

describe('AnswerPickerComponent', () => {
  let fixture: ComponentFixture<AnswerPickerComponent>;
  let component: AnswerPickerComponent;
  let http: HttpTestingController;
  let emitted: string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AnswerPickerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AnswerPickerComponent);
    component = fixture.componentInstance;
    emitted = [];
    component.answerChange.subscribe((id) => emitted.push(id));
  });

  afterEach(() => http.verify());

  function flushSearch(url: string): void {
    tick(300);
    http
      .expectOne((r) => r.url === `${BACKEND}/${url}`)
      .flush({
        calls: [{ id: 'c1', original_url: 'u', url: 'https://api.supplier.com/v2/fares/quote', method: 'POST', timestamp: 't', duration_ms: 1, status: 500 }],
        total: 1,
      });
  }

  const ANSWER = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    kind: 'RECORDED',
    status: 500,
    sizeBytes: 38,
    secretsKept: false,
    secretNames: ['set-cookie'],
    createdAt: 'now',
  };

  it('searches outbound calls first, and inbound ones through the internal-calls endpoint', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');
    expect(component.results().length).toBe(1);

    component.setDirection('inbound');
    flushSearch('internal-calls');
  }));

  it('asks keep or strip on a 409, and retries with the choice', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    component.pick(component.results()[0]);
    const first = http.expectOne(`${BACKEND}/interception/answers/from-call`);
    expect(first.request.body).toEqual({ direction: 'outbound', callId: 'c1', keepSecrets: null });
    first.flush({ error: 'secrets-decision-required', secretNames: ['set-cookie', 'x-auth-token'] }, { status: 409, statusText: 'Conflict' });

    expect(component.pending()?.secretNames).toEqual(['set-cookie', 'x-auth-token']);
    expect(emitted).toEqual([]);

    component.keepSecrets(false);
    const retry = http.expectOne(`${BACKEND}/interception/answers/from-call`);
    expect(retry.request.body.keepSecrets).toBeFalse();
    retry.flush(ANSWER, { status: 201, statusText: 'Created' });

    expect(component.pending()).toBeNull();
    expect(emitted).toEqual([ANSWER.id]);
  }));

  it('states both the cap and the size when a response is too large', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    component.pick(component.results()[0]);
    http
      .expectOne(`${BACKEND}/interception/answers/from-call`)
      .flush({ error: 'answer-too-large', limitBytes: 10485760, sizeBytes: 12582912 }, { status: 413, statusText: 'Too Large' });

    expect(component.error()).toContain('12.0 MB');
    expect(component.error()).toContain('10.0 MB');
  }));

  it('shows the attached answer instead of the search once the action has one', fakeAsync(() => {
    fixture.componentRef.setInput('answerId', ANSWER.id);
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/interception/answers/${ANSWER.id}`).flush(ANSWER);
    tick(300);
    fixture.detectChanges();

    expect(component.showPicker()).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('SECRETS STRIPPED');
    expect(fixture.nativeElement.textContent).not.toContain('set-cookie');
  }));

  it('uploads a file when uploadMode is set, without searching for calls', fakeAsync(() => {
    fixture.componentRef.setInput('uploadMode', true);
    fixture.detectChanges();

    const file = new File(['{}'], 'stub.json', { type: 'application/json' });
    component.uploadFile.set(file);
    component.uploadContentType.set('application/json');
    component.upload();

    const req = http.expectOne(`${BACKEND}/interception/answers`);
    expect(req.request.body instanceof FormData).toBeTrue();
    req.flush({ ...ANSWER, kind: 'FILE', id: ANSWER.id, secretsKept: null, secretNames: [] });

    expect(emitted).toEqual([ANSWER.id]);
  }));

  it('states the cap and the size when an upload is too large', fakeAsync(() => {
    fixture.componentRef.setInput('uploadMode', true);
    fixture.detectChanges();

    component.uploadFile.set(new File(['x'], 'big.bin', { type: 'application/octet-stream' }));
    component.upload();

    http
      .expectOne(`${BACKEND}/interception/answers`)
      .flush({ error: 'answer-too-large', limitBytes: 10485760, sizeBytes: 12582912 }, { status: 413, statusText: 'Too Large' });

    expect(component.error()).toContain('12.0 MB');
    expect(component.error()).toContain('10.0 MB');
  }));
});
