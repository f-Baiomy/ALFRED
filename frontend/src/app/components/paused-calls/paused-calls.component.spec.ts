import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PausedCall } from '../../core/models/interception.model';
import { AppConfigService } from '../../core/services/app-config.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { PausedCallsComponent } from './paused-calls.component';
import { By } from '@angular/platform-browser';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { HeaderEditorComponent } from '../header-editor/header-editor.component';

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
    http.match(`${BACKEND}/interception/sensitive-headers`).forEach((r) => r.flush({ names: ['cookie', 'x-api-key'] }));
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));
    fixture.detectChanges();
    flushOpenCardDetail(calls);
    fixture.detectChanges();
  }

  /**
   * The queue carries no bodies - they are fetched for the one card that is open (see
   * InterceptionApiService.getPausedDetail). Answering with the same card the test built is what
   * the real backend does, so every assertion below still reads the bodies it set up.
   */
  function flushOpenCardDetail(calls: PausedCall[]): void {
    const byId = new Map(calls.map((call) => [call.callId, call]));
    http
      .match((request) => request.method === 'GET' && /\/interception\/paused\/[^/]+$/.test(request.url))
      .forEach((request) => {
        const id = request.request.url.split('/').pop() ?? '';
        request.flush(byId.get(id) ?? null);
      });
  }

  /**
   * The body editor on screen. Its own state (mode, search, painted lines) lives in the shared
   * BodyEditorComponent now, so assertions about it read the child - after a render, because
   * the child only sees a new body once its input is set.
   */
  function editor(): BodyEditorComponent {
    fixture.detectChanges();
    const el = fixture.debugElement.query(By.directive(BodyEditorComponent));
    return el.componentInstance as BodyEditorComponent;
  }

  /** The header editor, on the Headers tab - which is where it lives. */
  function headerEditor(): HeaderEditorComponent {
    component.tab.set('headers');
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(HeaderEditorComponent)).componentInstance as HeaderEditorComponent;
  }

  afterEach(() => {
    // A test that selects another card asks for that card's bodies too. Draining those here keeps
    // every test about what it is actually testing rather than about the lazy fetch.
    http
      .match((request) => request.method === 'GET' && /\/interception\/paused\/[^/]+$/.test(request.url))
      .forEach((request) => request.flush(null));
    http.verify({ ignoreCancelled: true });
  });

  // The xmlns matters: a namespace prefix with no declaration is not well-formed XML and
  // DOMParser rejects it - which is exactly what keeps an HTML error page from being read as a
  // SOAP envelope. A real supplier response always declares it.
  const SOAP =
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body><Search><Origin>CAI</Origin></Search></soap:Body></soap:Envelope>';

  it('renders nothing at all when nothing is paused', () => {
    load([]);

    expect(fixture.nativeElement.querySelector('.paused-panel')).toBeNull();
  });

  // ---- the queue is summaries; bodies belong to the card you opened ------------------------
  //
  // The list is re-read on every paused-changed event, several a second while somebody is
  // working, once per open tab. A card carries a whole request and a whole response - measured at
  // 250-300 KB for a supplier search - so six held calls made that response 1.75 MB, rebuilt and
  // thrown away over and over, which exhausted the backend's heap on its own.

  it('asks for the open card body, and shows it once it arrives', () => {
    const summary = paused({ callId: 'a', request: null, response: { status: 200, headers: null, body: null } });
    fixture.detectChanges();
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    http.expectOne(`${BACKEND}/interception/paused`).flush([summary]);
    http.expectOne(`${BACKEND}/interception/enabled`).flush({ enabled: true });
    http.match(`${BACKEND}/interception/sensitive-headers`).forEach((r) => r.flush({ names: ['cookie', 'x-api-key'] }));
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));
    fixture.detectChanges();

    // Nothing to show yet - the summary has no body on it at all.
    expect(component.originalBody()).toBe('');

    http.expectOne(`${BACKEND}/interception/paused/a`).flush(paused({ callId: 'a' }));
    fixture.detectChanges();

    expect(component.originalBody()).toContain('CONFIRMED');
  });

  it('asks once per card, not again on every list refresh', () => {
    load([paused({ callId: 'a' })]);

    // A refresh that changed nothing about this card must not re-download its body.
    component.state.refreshPaused();
    http.expectOne(`${BACKEND}/interception/paused`).flush([paused({ callId: 'a' })]);
    fixture.detectChanges();

    http.expectNone(`${BACKEND}/interception/paused/a`);
  });

  it('asks again when the same call comes back on its other half', () => {
    load([paused({ callId: 'a', phase: 'request' })]);

    // A followed call returning for its response half is a different thing to read, so the body
    // it is holding now is not the one already in hand.
    component.state.refreshPaused();
    http.expectOne(`${BACKEND}/interception/paused`).flush([paused({ callId: 'a', phase: 'response' })]);
    fixture.detectChanges();

    http.expectOne(`${BACKEND}/interception/paused/a`).flush(paused({ callId: 'a', phase: 'response' }));
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

  it('mocks a network failure with only the field that mode actually reads', () => {
    load([paused()]);

    component.toggleFailure();
    component.onFailureModeChange('GATEWAY_ERROR');
    component.failureStatus.set(503);
    component.simulateFailure();

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.body).toEqual({
      action: 'simulate_failure',
      failure: { mode: 'GATEWAY_ERROR', durationMs: null, status: 503, body: null },
    });
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('leaves the duration/status/body a mode does not use out of the request entirely', () => {
    load([paused()]);

    component.toggleFailure();
    component.onFailureModeChange('CONNECTION_RESET');
    // None of these should end up in the payload: CONNECTION_RESET reads none of them.
    component.failureDurationMs.set(9999);
    component.failureStatus.set(500);
    component.failureBody.set('leftover');
    component.simulateFailure();

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.body).toEqual({
      action: 'simulate_failure',
      failure: { mode: 'CONNECTION_RESET', durationMs: null, status: null, body: null },
    });
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('seeds the truncated-body field from the real body, not a blank box', () => {
    load([paused({ response: { status: 200, headers: {}, body: '{"real":true}' } })]);

    component.toggleFailure();

    // currentBody() pretty-prints, same as the "Replace everything at once" panel seeds from it -
    // the point of this test is that it is the REAL body, not that it is minified.
    expect(component.failureBody()).toContain('"real": true');
  });

  it('closes the failure panel once the decision goes out, same as the replace panel', () => {
    load([paused()]);
    component.toggleFailure();
    expect(component.failureOpen()).toBeTrue();

    component.simulateFailure();
    http.expectOne(`${BACKEND}/interception/paused/call-1/decision`).flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);

    expect(component.failureOpen()).toBeFalse();
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

    component.onBodyChange('{"edited":true}');

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/control`);
    expect(request.request.method).toBe('POST');
    request.flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('does not re-claim a call it already holds', () => {
    load([paused({ heldAt: Date.now() })]);

    component.onBodyChange('{"edited":true}');

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

  describe('editing headers while the caller waits', () => {
    it('sends only the headers that changed, not the whole set', () => {
      // Rewriting forty headers to change one would make an untouched release stop being
      // byte-identical to never having paused.
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1', b: '2' }, body: '{}' } })]);

      headerEditor().onValue(1, { target: { value: 'changed' } } as unknown as Event);

      expect(component.headerChanges()).toEqual({ b: 'changed' });
      expect(component.headerChangeCount()).toBe(1);
      expect(component.dirty()).toBeTrue();
    });

    it('removes a header by sending a null value, which is what the proxy reads as delete', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1' }, body: '{}' } })]);

      headerEditor().toggleRemoved(0);

      expect(component.headerChanges()).toEqual({ a: null });
      // The row stays, struck through - "did I delete it or was it never here" must stay answerable.
      expect(component.headerRows().length).toBe(1);
      expect(component.headerRows()[0].removed).toBeTrue();
    });

    it('un-removing a header puts it back with nothing to send', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1' }, body: '{}' } })]);

      headerEditor().toggleRemoved(0);
      headerEditor().toggleRemoved(0);

      expect(component.headerChanges()).toEqual({});
      expect(component.dirty()).toBeFalse();
    });

    it('drops an added header that is removed again rather than sending a blank one', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{}' } })]);

      headerEditor().addRow();
      headerEditor().toggleRemoved(0);

      expect(component.headerRows().length).toBe(0);
    });

    it('carries the header edits on the release', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1' }, body: '{}' } })]);

      headerEditor().onValue(0, { target: { value: '2' } } as unknown as Event);
      component.release(true);

      const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
      expect(request.request.body.headers).toEqual({ a: '2' });
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('sends nothing at all on an unchanged release, however much was opened', () => {
      load([paused({ heldAt: Date.now() })]);

      component.release(false);

      const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
      expect(request.request.body).toEqual({ action: 'release' });
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });
  });

  describe('replacing a whole half at once', () => {
    it('applies a pasted status, headers and body', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1' }, body: '{}' } })]);

      component.replaceText.set('{"status":503,"headers":{"x-new":"yes"},"body":"gone"}');
      component.applyReplacement();

      expect(component.currentStatus()).toBe(503);
      expect(component.currentBody()).toBe('gone');
      // Anything the paste left out is REMOVED - a replace that quietly kept it would be lying.
      expect(component.headerChanges()).toEqual({ 'x-new': 'yes', a: null });
    });

    it('refuses invalid JSON with a message instead of silently doing nothing', () => {
      load([paused({ heldAt: Date.now() })]);

      component.replaceText.set('{not json');
      component.applyReplacement();

      expect(component.replaceError()).toContain('not valid JSON');
      expect(component.dirty()).toBeFalse();
    });

    it('refuses headers that are not an object of name to value', () => {
      load([paused({ heldAt: Date.now() })]);

      component.replaceText.set('{"headers":["content-type"]}');
      component.applyReplacement();

      expect(component.replaceError()).toContain('headers must be an object');
    });
  });

  it('claims the call on a header edit, the same as on a body edit', () => {
    // Typing is proof enough that somebody is here; a header edited under a running countdown is
    // exactly what taking control exists to prevent.
    load([paused()]);

    headerEditor().addRow();

    http.expectOne(`${BACKEND}/interception/paused/call-1/control`).flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  it('keeps an edit that was itself what claimed the call', () => {
    // Caught on live traffic. Editing claims the call, claiming re-fetches the list, and the same
    // call comes back as a new object - so an effect keyed on object identity threw the very edit
    // away that had triggered the claim. Only a second edit ever survived.
    load([paused({ response: { status: 200, headers: { a: '1' }, body: '{}' } })]);

    headerEditor().onValue(0, { target: { value: 'edited' } } as unknown as Event);
    http.expectOne(`${BACKEND}/interception/paused/call-1/control`).flush(null);
    // The refresh the claim triggers, with the same call carrying its new heldAt.
    http
      .expectOne(`${BACKEND}/interception/paused`)
      .flush([paused({ heldAt: Date.now(), response: { status: 200, headers: { a: '1' }, body: '{}' } })]);
    fixture.detectChanges();

    expect(component.headerChanges()).toEqual({ a: 'edited' });
  });

  it('still drops edits when a different call is selected', () => {
    load([paused(), paused({ callId: 'call-2', heldAt: Date.now() })]);

    component.onBodyChange('for call one');
    http.expectOne(`${BACKEND}/interception/paused/call-1/control`).flush(null);
    http.expectOne(`${BACKEND}/interception/paused`).flush([paused({ heldAt: Date.now() }), paused({ callId: 'call-2' })]);

    component.select(paused({ callId: 'call-2' }));
    fixture.detectChanges();

    expect(component.dirty()).toBeFalse();
  });

  describe('reading and editing the body', () => {

    it('pretty-prints a minified JSON body on arrival', () => {
      // A 4 KB payload on one line cannot be read, let alone edited.
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1,"b":[2]}' } })]);

      expect(component.currentBody()).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
      expect(component.bodyKind()).toBe('json');
    });

    it('pretty-prints a SOAP body too', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: SOAP } })]);

      expect(component.bodyKind()).toBe('xml');
      expect(component.currentBody().split('\n').length).toBeGreaterThan(3);
    });

    it('does not count formatting as an edit', () => {
      // The property this must not break: an untouched release stays byte-identical to never
      // having paused, so pretty-printing on arrival cannot make every call look edited.
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      expect(component.currentBody()).not.toBe('{"a":1}');
      expect(component.bodyEdited()).toBeFalse();
      expect(component.dirty()).toBeFalse();
    });

    it('sends nothing when the body was only reformatted', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      editor().format();
      component.release(true);

      const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
      expect(request.request.body.body).toBeNull();
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('sends exactly what is on screen once a value really changes', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      component.onBodyChange('{\n  "a": 2\n}');
      expect(component.bodyEdited()).toBeTrue();

      component.release(true);
      const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
      expect(request.request.body.body).toBe('{\n  "a": 2\n}');
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('leaves a body it cannot parse exactly as it arrived', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: 'grant_type=x&scope=read' } })]);

      expect(component.currentBody()).toBe('grant_type=x&scope=read');
      expect(editor().canFormat()).toBeFalse();
      expect(component.bodyKind()).toBe('text');
    });

    it('reports a body that stops parsing while it is being typed', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      component.onBodyChange('{"a":');

      expect(editor().validity().state).toBe('invalid');
      expect(editor().validity().message?.length).toBeGreaterThan(0);
    });

    it('counts and cycles through matches', () => {
      load([
        paused({
          heldAt: Date.now(),
          response: { status: 200, headers: {}, body: '{"seats":1,"seatsRemaining":2}' },
        }),
      ]);

      editor().onQuery({ target: { value: 'seats' } } as unknown as Event);
      expect(editor().matches().length).toBe(2);
      expect(editor().matchLabel()).toBe('1/2');

      editor().step(1);
      expect(editor().matchLabel()).toBe('2/2');
      // Wraps rather than stopping at the end.
      editor().step(1);
      expect(editor().matchLabel()).toBe('1/2');
    });

    it('says so when nothing matches, rather than looking broken', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      editor().onQuery({ target: { value: 'zzz' } } as unknown as Event);

      expect(editor().matchLabel()).toBe('no matches');
    });

    it('renders Inspect with the same line/token shape the call cards use', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      expect(editor().inspectLines().length).toBe(0); // nothing built while in Edit
      editor().setBodyMode('inspect');

      const lines = editor().inspectLines();
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0].index).toBe(0);
      expect(lines[0].tokens.length).toBeGreaterThan(0);
      expect(editor().inspectVariant()).toBe('json');
    });

    it('colours a SOAP body as markup, and a form-encoded one as plain text', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: SOAP } })]);
      editor().setBodyMode('inspect');
      expect(editor().inspectVariant()).toBe('json'); // the tokenizer differs, the renderer does not

      component.onBodyChange('grant_type=x');
      expect(editor().inspectVariant()).toBe('plain');
    });
  });

  describe('the coloured editor', () => {
    const BIG = '{"a":"' + 'x'.repeat(520_000) + '"}';

    it('paints the same tokens Inspect would, so the two cannot disagree', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      const painted = editor().editorLines();
      editor().setBodyMode('inspect');
      const inspected = editor().inspectLines();

      expect(painted.length).toBe(inspected.length);
      expect(painted[0].tokens.map((t) => [t.cls, t.text]))
        .toEqual(inspected[0].tokens.map((t) => [t.cls, t.text]));
    });

    it('colours a JSON key, string and number the way the call cards do', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":"x","b":2}' } })]);

      const classes = editor().editorLines().flatMap((line) => line.tokens.map((t) => t.cls));

      expect(classes).toContain('k'); // key -> --tok-key
      expect(classes).toContain('s'); // string -> --tok-string
      expect(classes).toContain('n'); // number -> --tok-number
    });

    it('colours XML through the XML tokenizer, not the JSON one', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: SOAP } })]);

      const tokens = editor().editorLines().flatMap((line) => line.tokens);

      expect(tokens.some((t) => t.cls === 'k' && t.text.startsWith('<soap:'))).toBeTrue();
    });

    it('leaves a plain-text body uncoloured rather than colouring it as JSON', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: 'grant_type=x&scope=read' } })]);

      expect(editor().editorLines().flatMap((l) => l.tokens).every((t) => !t.cls)).toBeTrue();
    });

    it('highlights search matches in the editor, not only in Inspect', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"seats":1}' } })]);

      editor().onQuery({ target: { value: 'seats' } } as unknown as Event);

      expect(editor().editorLines().flatMap((l) => l.tokens).some((t) => t.highlighted)).toBeTrue();
    });

    it('switches the paint off for a body too large to retokenize per keystroke', () => {
      // Worse to make typing unusable than to show monochrome text.
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: BIG } })]);

      expect(editor().overlayEnabled()).toBeFalse();
      expect(editor().editorLines()).toEqual([]);
    });

    it('builds nothing for the layer that is not on screen', () => {
      load([paused({ heldAt: Date.now(), response: { status: 200, headers: {}, body: '{"a":1}' } })]);

      expect(editor().inspectLines()).toEqual([]);
      editor().setBodyMode('inspect');
      expect(editor().editorLines()).toEqual([]);
      expect(editor().inspectLines().length).toBeGreaterThan(0);
    });

    it('keeps the editor a fixed size and scrolls the body inside it', () => {
      // The gutter is one span per line, and as a flex item its natural height is all of them -
      // which turned a 200-line payload into a 3,400px box and the page, not the editor, into
      // the thing that scrolled. Caught by measuring, not by looking.
      load([
        paused({
          heldAt: Date.now(),
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]))),
          },
        }),
      ]);

      const box = fixture.nativeElement.querySelector('.body-editor') as HTMLElement;
      const area = fixture.nativeElement.querySelector('.body-editor textarea') as HTMLTextAreaElement;

      expect(editor().lineNumbers().length).toBeGreaterThan(190);
      expect(box.getBoundingClientRect().height).toBeLessThan(700);
      expect(area.scrollHeight).toBeGreaterThan(area.clientHeight);
    });

    it('scrolls the painted layer and the gutter in step with the textarea', () => {
      // Both axes: the textarea does not wrap, and a horizontal scroll that moved only the caret
      // would slide the text out from under it.
      load([
        paused({
          heldAt: Date.now(),
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]))),
          },
        }),
      ]);

      const area = fixture.nativeElement.querySelector('.body-editor textarea') as HTMLTextAreaElement;
      const pre = fixture.nativeElement.querySelector('.body-highlight') as HTMLElement;
      const gutter = fixture.nativeElement.querySelector('.body-gutter') as HTMLElement;

      area.scrollTop = 120;
      area.scrollLeft = 30;
      editor().syncGutter();

      expect(pre.scrollTop).toBe(area.scrollTop);
      expect(pre.scrollLeft).toBe(area.scrollLeft);
      expect(gutter.scrollTop).toBe(area.scrollTop);
    });
  });

  /**
   * Following a call through its whole cycle.
   *
   * The card used to disappear the instant you pressed Send, so you never saw the answer. It now
   * outlives the half it was paused on, and the thing these guard is that outliving it does not
   * quietly turn a card that holds nobody into one that looks like it does.
   */
  describe('following a call past the half it was paused on', () => {
    const inFlight = (overrides: Partial<PausedCall> = {}) =>
      paused({
        callId: 'flying',
        phase: 'request',
        response: null,
        stage: 'in-flight',
        cycle: { follow: true, releasedAt: Date.now() - 3000, requestEdit: 'body' },
        ...overrides,
      });

    const finished = (overrides: Partial<PausedCall> = {}) =>
      paused({
        callId: 'done',
        phase: 'request',
        stage: 'finished',
        cycle: {
          follow: false,
          releasedAt: Date.now() - 1400,
          finishedAt: Date.now(),
          durationMs: 1400,
          outcome: 'completed',
          requestEdit: 'body',
        },
        ...overrides,
      });

    it('offers no decision at all on a card that holds nobody', () => {
      // Every button in that footer acts on a waiting socket. Showing them for a call that has
      // already been answered invites a decision that can never reach anything.
      load([inFlight()]);

      expect(fixture.nativeElement.querySelector('.paused-foot')).toBeNull();
      expect(fixture.nativeElement.querySelector('.paused-follow')).toBeNull();
      expect(component.editable()).toBeFalse();
    });

    it('keeps the decision footer for a call that is still holding', () => {
      load([paused({ phase: 'request', response: null })]);

      expect(fixture.nativeElement.querySelector('.paused-foot')).not.toBeNull();
      expect(component.editable()).toBeTrue();
    });

    it('shows the response of a finished card even though the pause was on the request', () => {
      load([finished()]);

      expect(component.tab()).toBe('response');
      expect(component.currentBody()).toContain('CONFIRMED');
      expect(editor().effectiveMode()).toBe('inspect');
    });

    it('shows each half on its own tab rather than one over the other', () => {
      load([finished()]);

      component.tab.set('request');
      expect(component.currentBody()).toContain('"a": 1');

      component.tab.set('response');
      expect(component.currentBody()).toContain('CONFIRMED');
    });

    it('never paints an edit from one half onto the other', () => {
      // A held response whose "Request sent" tab is open must show the REQUEST, not the response
      // body being typed into. currentBody feeds the editor, the highlighter and the release.
      load([paused({ heldAt: Date.now() })]);
      component.editedBody.set('{"status":"FAILED"}');

      component.tab.set('request');

      expect(component.currentBody()).not.toContain('FAILED');
      expect(component.currentBody()).toContain('"a": 1');
      // Still counted as an edit - it belongs to the held half, whatever tab is open.
      expect(component.bodyEdited()).toBeTrue();
    });

    it('asks to be stopped again only when the box is ticked', () => {
      load([paused({ callId: 'c1', phase: 'request', response: null, heldAt: Date.now() })]);

      component.follow.set(true);
      component.release(false);

      const request = http.expectOne(`${BACKEND}/interception/paused/c1/decision`);
      expect(request.request.body).toEqual({ action: 'release', follow: true });
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('still sends the action and nothing else when it is not ticked', () => {
      // The byte-identical property: an untouched release must carry no other key at all, not
      // even one that happens to be false.
      load([paused({ callId: 'c1', phase: 'request', response: null, heldAt: Date.now() })]);

      component.release(false);

      const request = http.expectOne(`${BACKEND}/interception/paused/c1/decision`);
      expect(request.request.body).toEqual({ action: 'release' });
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('never offers a second stop on a response, because there is no third half', () => {
      load([paused({ callId: 'c1', heldAt: Date.now() })]);
      component.follow.set(true);

      component.release(false);

      const request = http.expectOne(`${BACKEND}/interception/paused/c1/decision`);
      expect(request.request.body).toEqual({ action: 'release' });
      request.flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    });

    it('drops the edits when the answer to a followed call arrives on the same card', () => {
      // Same call id, other half. Keyed on identity or on the id alone, a body typed for the
      // request would be carried onto the response that answered it.
      load([paused({ callId: 'c1', phase: 'request', response: null, heldAt: Date.now() })]);
      component.editedBody.set('{"a":2}');
      expect(component.bodyEdited()).toBeTrue();

      component.state.refreshPaused();
      http
        .expectOne(`${BACKEND}/interception/paused`)
        .flush([paused({ callId: 'c1', phase: 'response', heldAt: Date.now() })]);
      fixture.detectChanges();

      expect(component.editedBody()).toBeNull();
      expect(component.tab()).toBe('response');
    });

    it('does not label an already-forwarded request "edit before forwarding"', () => {
      // A held RESPONSE still has a request tab, and that request is long gone. The label asked
      // whether the tab you were on was editable rather than whether the request was, so opening
      // a held response offered to edit a request that had already left.
      load([paused({ heldAt: Date.now() })]);

      const tabs = Array.from(fixture.nativeElement.querySelectorAll('.paused-tabs button')) as HTMLElement[];

      expect(tabs[0].textContent).toContain('Request sent');
      expect(tabs[1].textContent).toContain('edit before release');
    });

    it('closes a finished card and refuses to close one that is still holding', () => {
      load([finished(), paused({ callId: 'holding' })]);

      expect(component.closable(component.state.pausedCalls()[0])).toBeTrue();
      expect(component.closable(component.state.pausedCalls()[1])).toBeFalse();

      component.close(component.state.pausedCalls()[0]);
      http.expectOne({ method: 'DELETE', url: `${BACKEND}/interception/paused/done` }).flush(null);
      http.expectOne(`${BACKEND}/interception/paused`).flush([paused({ callId: 'holding' })]);
    });

    it('counts only the calls that are actually holding somebody', () => {
      // The badge in the tab bar reads this. A number that included followed and finished cards
      // would shout about calls nobody is waiting on, and a badge that cries wolf gets ignored.
      load([paused({ callId: 'holding' }), inFlight(), finished()]);

      expect(component.state.pausedCount()).toBe(1);
      expect(component.state.inFlightCount()).toBe(1);
      expect(component.state.finishedCount()).toBe(1);
    });

    it('treats a payload with no stage as a call that is holding', () => {
      // A proxy or a backend mid-upgrade sends no stage at all, and defaulting the other way
      // would hide a real waiting socket.
      load([paused({ stage: undefined })]);

      expect(component.holding()).toBeTrue();
      expect(component.state.pausedCount()).toBe(1);
    });
  });
});
