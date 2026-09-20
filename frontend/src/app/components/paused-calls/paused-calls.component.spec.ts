import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PausedCall } from '../../core/models/interception.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { PausedCallsComponent } from './paused-calls.component';

const BACKEND = 'http://backend.test:5000';

function paused(overrides: Partial<PausedCall> = {}): PausedCall {
  return {
    callId: 'call-1',
    phase: 'response',
    source: 'outbound',
    ruleId: 'r1',
    ruleName: 'Review Sabre orders',
    timeoutSeconds: 30,
    onTimeout: 'release',
    method: 'POST',
    url: 'https://api.sabre.com/v4/order/create',
    request: { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    response: { status: 200, headers: {}, body: '{"status":"CONFIRMED"}' },
    pausedAt: Date.now(),
    ...overrides,
  };
}

describe('PausedCallsComponent', () => {
  let fixture: ComponentFixture<PausedCallsComponent>;
  let component: PausedCallsComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PausedCallsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PausedCallsComponent);
    component = fixture.componentInstance;
  });

  function load(calls: PausedCall[]): void {
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    http.expectOne(`${BACKEND}/interception/paused`).flush(calls);
    http.expectOne(`${BACKEND}/interception/enabled`).flush({ enabled: true });
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));
    fixture.detectChanges();
  }

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
  });

  it('renders nothing at all when nothing is paused', () => {
    load([]);

    expect(fixture.nativeElement.querySelector('.paused-panel')).toBeNull();
  });

  it('selects the first paused call so there is always something to act on', () => {
    load([paused({ callId: 'a' }), paused({ callId: 'b' })]);

    expect(component.selected()?.callId).toBe('a');
  });

  it('counts down from the deadline the backend stamped, not from render time', () => {
    // pausedAt 10s ago on a 30s timeout leaves 20s - if this were measured from when the
    // component rendered it would wrongly read 30.
    load([paused({ pausedAt: Date.now() - 10_000, timeoutSeconds: 30 })]);

    // ~20s, not ~30. A second of slack either way: the ticker is seeded when the component is
    // constructed and the fixture is stamped a moment later, so Math.ceil can land on either side.
    // The point of the assertion is that it is nowhere near 30, which is what measuring from
    // render time would produce.
    expect(component.secondsLeft(component.selected()!)).toBeGreaterThanOrEqual(19);
    expect(component.secondsLeft(component.selected()!)).toBeLessThanOrEqual(21);
  });

  it('never counts below zero', () => {
    load([paused({ pausedAt: Date.now() - 90_000, timeoutSeconds: 30 })]);

    expect(component.secondsLeft(component.selected()!)).toBe(0);
  });

  it('is not dirty until the body actually differs from what came back', () => {
    load([paused()]);

    expect(component.dirty()).toBeFalse();

    component.editedBody.set('{"status":"CONFIRMED"}');
    expect(component.dirty()).toBeFalse();

    component.editedBody.set('{"status":"FAILED"}');
    expect(component.dirty()).toBeTrue();
  });

  it('sends nothing but the action when releasing unchanged', () => {
    load([paused()]);

    component.release(false);

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    // An unchanged release must not carry the body back: the proxy would rewrite a payload that
    // may be megabytes, making "send unchanged" subtly different from never having paused.
    expect(request.request.body).toEqual({ action: 'release' });
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('sends only the fields that were actually edited', () => {
    load([paused()]);

    component.editedBody.set('{"status":"FAILED"}');
    component.release(true);

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.body.body).toBe('{"status":"FAILED"}');
    expect(request.request.body.status).toBeNull();
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('sends an edited status alongside an untouched body', () => {
    load([paused()]);

    component.editedStatus.set(500);
    component.release(true);

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.body.status).toBe(500);
    expect(request.request.body.body).toBeNull();
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('aborts without carrying any edit', () => {
    load([paused()]);

    component.editedBody.set('{"ignored":true}');
    component.abort();

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.body).toEqual({ action: 'abort' });
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('refreshes rather than erroring when the call stopped waiting mid-decision', () => {
    load([paused()]);

    component.release(false);
    http.expectOne(`${BACKEND}/interception/paused/call-1/decision`).flush(null, {
      status: 404,
      statusText: 'Not Found',
    });

    // Its timeout fired, or another tab answered it. There is nothing left to act on, so the
    // only remedy is to reload the queue.
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    expect(component.busy()).toBeFalse();
  });

  it('counts down while nobody has taken control', () => {
    load([paused({ pausedAt: Date.now() - 5_000, timeoutSeconds: 30 })]);

    expect(component.held(component.selected()!)).toBeFalse();
    expect(component.secondsLeft(component.selected()!)).toBeGreaterThan(20);
  });

  it('stops counting down and counts up once control is taken', () => {
    // The timeout is a grace period for somebody to NOTICE the call. Once they have, the row must
    // stop reading as urgent, because nothing is expiring any more.
    load([paused({ pausedAt: Date.now() - 25_000, timeoutSeconds: 30, heldAt: Date.now() - 65_000 })]);

    const call = component.selected()!;
    expect(component.held(call)).toBeTrue();
    expect(component.urgent(call)).toBeFalse();
    expect(component.heldFor(call)).toMatch(/^1m \d\d s?|^1m \d\d/);
  });

  it('claims the call on the first keystroke, without waiting for the button', () => {
    load([paused()]);

    component.onBodyInput({ target: { value: '{"edited":true}' } } as unknown as Event);

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/control`);
    expect(request.request.method).toBe('POST');
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('does not re-claim a call it already holds', () => {
    load([paused({ heldAt: Date.now() })]);

    component.onBodyInput({ target: { value: '{"edited":true}' } } as unknown as Event);

    http.expectNone(`${BACKEND}/interception/paused/call-1/control`);
  });

  it('take control posts to the control endpoint, not to decision', () => {
    load([paused()]);

    component.takeControl(component.selected()!);

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/control`);
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    // Taking control is explicitly NOT a decision - the call is still waiting afterwards.
    http.expectNone(`${BACKEND}/interception/paused/call-1/decision`);
  });

  it('edits the request half when the breakpoint is on the request', () => {
    load([paused({ phase: 'request', response: null })]);

    expect(component.originalBody()).toBe('{"a":1}');
  });
});
