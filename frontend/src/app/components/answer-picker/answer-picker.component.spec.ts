import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { By } from '@angular/platform-browser';
import { CallFinderComponent } from '../call-finder/call-finder.component';
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

  /** The search lives in the child finder; the picker only decides what choosing means. */
  function finder(): CallFinderComponent {
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(CallFinderComponent)).componentInstance;
  }

  const C1 = { id: 'c1', original_url: 'u', url: 'https://api.supplier.com/v2/fares/quote', method: 'POST', timestamp: 't', duration_ms: 1, status: 500 };

  function summary(id: string, method: string, url: string, status: number | null) {
    return { id, original_url: url, url, method, timestamp: new Date().toISOString(), duration_ms: 10, status };
  }

  function flushSearch(url: string, calls: unknown[] = [C1], total = calls.length) {
    tick(300);
    const req = http.expectOne((r) => r.url === `${BACKEND}/${url}`);
    req.flush({ calls, total });
    return req;
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
    expect(finder().results().length).toBe(1);

    finder().setDirection('inbound');
    flushSearch('internal-calls');
  }));

  it('asks keep or strip on a 409, and retries with the choice', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    component.onChosen({ call: finder().results()[0], direction: finder().direction() });
    const first = http.expectOne(`${BACKEND}/interception/answers/from-call`);
    expect(first.request.body).toEqual({ direction: 'outbound', callId: 'c1', cycleId: null, keepSecrets: null });
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

    component.onChosen({ call: finder().results()[0], direction: finder().direction() });
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

  it('narrows to the rule by default: the path goes to the server, method and host are checked here', fakeAsync(() => {
    fixture.componentRef.setInput('ruleHost', 'api.supplier.com');
    fixture.componentRef.setInput('rulePath', '/v2/fares');
    fixture.componentRef.setInput('ruleMethods', ['POST']);
    fixture.detectChanges();

    const req = flushSearch('calls', [
      summary('a', 'POST', 'https://api.supplier.com/v2/fares/quote', 500),
      summary('b', 'GET', 'https://api.supplier.com/v2/fares', 200),
      summary('c', 'POST', 'https://other.com/v2/fares', 200),
    ]);
    expect(req.request.params.get('search')).toBe('/v2/fares');
    expect(req.request.params.get('limit')).toBe('200');
    expect(finder().results().map((c) => c.id)).toEqual(['a']);

    finder().toggleRule();
    const plain = flushSearch('calls');
    expect(plain.request.params.get('search')).toBe('');
    expect(plain.request.params.get('limit')).toBe('20');
  }));

  it("starts on inbound for an inbound rule, and sends the rule's projects", fakeAsync(() => {
    fixture.componentRef.setInput('ruleSource', 'inbound');
    fixture.componentRef.setInput('ruleServiceNames', ['shop']);
    fixture.detectChanges();

    const req = flushSearch('internal-calls');
    expect(req.request.params.get('serviceNames')).toBe('shop');
  }));

  it('filters by a typed status token, and a chip edits the same text', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    finder().onSearch({ target: { value: 'fares status:2xx' } } as unknown as Event);
    flushSearch('calls', [summary('ok', 'GET', 'https://a.com/fares', 200), summary('bad', 'GET', 'https://a.com/fares', 500)]);
    expect(finder().results().map((c) => c.id)).toEqual(['ok']);

    finder().toggleChip('methods', 'GET');
    expect(finder().search()).toBe('fares method:GET status:2xx');
    flushSearch('calls', []);
  }));

  it('keeps scanning older pages on its own until something matches, then Load more reads the next page', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    finder().onSearch({ target: { value: 'status:404' } } as unknown as Event);
    const noMatch = Array.from({ length: 200 }, (_, i) => summary(`n${i}`, 'GET', 'https://a.com/x', 200));
    flushSearch('calls', noMatch, 1000);
    const second = flushSearch('calls', [summary('hit', 'GET', 'https://a.com/x', 404), ...noMatch.slice(1)], 1000);
    expect(second.request.params.get('offset')).toBe('200');
    // Still under the fill target, so it reads on - capped, never the whole log.
    flushSearch('calls', noMatch, 1000);
    flushSearch('calls', noMatch, 1000);
    flushSearch('calls', noMatch, 1000);
    tick(300);
    http.expectNone((r) => r.url === `${BACKEND}/calls`);
    expect(finder().results().map((c) => c.id)).toEqual(['hit']);
    expect(finder().countText()).toBe('1 match in the newest 1000 of 1000 calls');
    expect(finder().hasMore()).toBeFalse();
  }));

  it('previews the response on click, and only its button copies it', fakeAsync(() => {
    fixture.detectChanges();
    flushSearch('calls');

    const call = finder().results()[0];
    finder().togglePreview(call, 0);
    http
      .expectOne(`${BACKEND}/calls/c1/detail`)
      .flush({ response: { status: 500, headers: { 'Content-Type': 'application/json' }, body: '{"error":"fare expired"}' } });
    const preview = finder().preview()!;
    expect(preview.contentType).toBe('application/json');
    expect(preview.sizeBytes).toBe(24);
    expect(preview.body).toContain('"error": "fare expired"');
    http.expectNone(`${BACKEND}/interception/answers/from-call`);

    component.onChosen({ call: call, direction: finder().direction() });
    http.expectOne(`${BACKEND}/interception/answers/from-call`).flush(ANSWER, { status: 201, statusText: 'Created' });
    expect(emitted).toEqual([ANSWER.id]);
  }));

  it('copies a preselected call straight away, through the same secrets prompt', fakeAsync(() => {
    fixture.componentRef.setInput('preselect', { direction: 'inbound', callId: 'in-7' });
    fixture.detectChanges();

    const req = http.expectOne(`${BACKEND}/interception/answers/from-call`);
    expect(req.request.body).toEqual({ direction: 'inbound', callId: 'in-7', cycleId: null, keepSecrets: null });
    req.flush({ error: 'secrets-decision-required', secretNames: ['set-cookie'] }, { status: 409, statusText: 'Conflict' });
    expect(component.pending()?.callId).toBe('in-7');
    flushSearch('internal-calls', []);
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
