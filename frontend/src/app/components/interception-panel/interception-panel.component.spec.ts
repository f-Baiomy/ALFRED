import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InterceptionPanelComponent } from './interception-panel.component';
import { CallInterception } from '../../core/models/interception.model';

/**
 * The panel is the only place the log admits that what you are reading is not what actually
 * happened on the wire, so the cases that matter here are the ones where it could stay silent:
 * a response swapped for another, and a response that never came from the host at all.
 */
describe('InterceptionPanelComponent', () => {
  let fixture: ComponentFixture<InterceptionPanelComponent>;
  let component: InterceptionPanelComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterceptionPanelComponent] }).compileComponents();
    fixture = TestBed.createComponent(InterceptionPanelComponent);
    component = fixture.componentInstance;
  });

  function render(interception: CallInterception, phase: 'request' | 'response' = 'response'): void {
    fixture.componentRef.setInput('interception', interception);
    fixture.componentRef.setInput('phase', phase);
    fixture.detectChanges();
  }

  const applied = [{ ruleId: 'r1', ruleName: 'Fail the upsell', action: 'REPLACE_RESPONSE' }];

  it('shows nothing for a half that came out the way it went in', () => {
    // A call that was only delayed has no snapshots at all. An "unchanged" notice on every
    // intercepted call's other half would be noise, and absent must not read as unchanged.
    render({ applied: [{ action: 'DELAY_RESPONSE' }] });

    expect(component.hasChange()).toBeFalse();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('shows both ends of a replaced response', () => {
    render({
      applied,
      originalResponse: { status: 200, reason: 'OK', headers: { 'x-upstream': 'yes' }, body: '{"offers":[1]}' },
      finalResponse: { status: 500, reason: 'Internal Server Error', headers: {}, body: '{"error":"Replaced by Alfred"}' },
    });

    expect(component.hasChange()).toBeTrue();
    expect(component.synthetic()).toBeFalse();
    expect(component.label().title).toBe('Response was changed before the caller saw it');

    component.toggle();
    fixture.detectChanges();

    expect(component.diff()?.statusChange).toBe('200 OK → 500 Internal Server Error');
    expect(component.diff()?.bodyChanged).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Replaced by Alfred');
  });

  it('reports a mocked response as one-sided rather than as a diff', () => {
    // There is no "before": upstream was never contacted. Claiming the host answered and that we
    // changed its answer would describe a call that never happened.
    render({
      applied: [{ action: 'MOCK_RESPONSE', detail: '418, upstream never contacted' }],
      finalResponse: { status: 418, headers: {}, body: 'teapot' },
    });

    expect(component.hasChange()).toBeTrue();
    expect(component.synthetic()).toBeTrue();
    expect(component.label().title).toContain('never contacted');
    expect(component.summary()).toBe('nothing was sent to the host');

    component.toggle();
    fixture.detectChanges();

    // Every line is an addition, because none of it came from the host.
    expect(component.diff()?.body.every((line) => line.kind === 'added')).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain("the whole reply above is Alfred's");
  });

  it('prefers the final snapshot over the logged call, which predates a hand edit', () => {
    // The request half is logged at prepare time, before a breakpoint lets anyone edit it.
    // Falling back to the logged call here would report no change on a call the record says was
    // edited by hand.
    render(
      {
        applied: [{ action: 'BREAKPOINT_RELEASE', detail: 'released edited: body' }],
        originalRequest: { method: 'POST', url: 'https://x/book', headers: {}, body: '{"pax":1}' },
        finalRequest: { method: 'POST', url: 'https://x/book', headers: {}, body: '{"pax":9}' },
      },
      'request'
    );
    fixture.componentRef.setInput('current', { headers: {}, body: '{"pax":1}' });
    component.toggle();
    fixture.detectChanges();

    expect(component.editedByHand()).toBeTrue();
    expect(component.diff()?.bodyChanged).toBeTrue();
  });

  it('only reports the actions belonging to its own half', () => {
    render({
      applied: [
        { action: 'SET_QUERY_PARAM', detail: 'passengers=5' },
        { action: 'SET_RESPONSE_STATUS', detail: '500' },
      ],
      originalResponse: { status: 200, headers: {}, body: '' },
      finalResponse: { status: 500, headers: {}, body: '' },
    });

    expect(component.actions().map((a) => a.action)).toEqual(['SET_RESPONSE_STATUS']);
  });

  /**
   * Reading the change, rather than decoding it. The panel used to render every line as plain
   * interpolated text and pretty-print JSON only - so a SOAP envelope was two vast, identical
   * lines and there was no way to search or copy any of it.
   */
  describe('reading what changed', () => {
    const jsonChange: CallInterception = {
      applied,
      originalResponse: {
        status: 200,
        reason: 'OK',
        headers: { 'x-supplier': 'amadeus' },
        body: '{"supplier":"amadeus","total":1420}',
      },
      finalResponse: {
        status: 500,
        reason: 'Internal Server Error',
        headers: { 'x-supplier': 'sabre' },
        body: '{"supplier":"sabre","total":1}',
      },
    };

    const soap = (total: string) =>
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soap:Body><Offer><Total currency="AED">${total}</Total></Offer></soap:Body></soap:Envelope>`;

    let copied: string;
    let originalClipboard: PropertyDescriptor | undefined;

    beforeEach(() => {
      copied = '';
      // The clipboard is replaced outright rather than spied on. navigator.clipboard is a global
      // that another spec file legitimately swaps out, so spyOn here depends on the random order
      // Karma happened to pick - which is how this first failed.
      originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (value: string) => {
            copied = value;
            return Promise.resolve();
          },
        },
      });
    });

    afterEach(() => {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    });

    /** Renders and expands. Only toggles when closed - toggling an open panel shuts it. */
    function open(interception: CallInterception): void {
      render(interception);
      if (!component.open()) component.toggle();
      fixture.detectChanges();
    }

    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

    it('names the format it is showing, so plain text is never a mystery', () => {
      open(jsonChange);
      expect(component.kindLabel()).toBe('JSON');

      open({
        applied,
        originalResponse: { status: 200, headers: {}, body: soap('1420.00') },
        finalResponse: { status: 200, headers: {}, body: soap('1.00') },
      });
      expect(component.kindLabel()).toBe('XML');
    });

    it('pretty-prints and colours a SOAP envelope, which used to be two enormous lines', () => {
      open({
        applied,
        originalResponse: { status: 200, headers: {}, body: soap('1420.00') },
        finalResponse: { status: 200, headers: {}, body: soap('1.00') },
      });

      const lines = fixture.nativeElement.querySelectorAll('.intercept-body .il');
      expect(lines.length).toBeGreaterThan(4);
      // Coloured by the shared token renderer - the same one the call cards use.
      expect(fixture.nativeElement.querySelector('.intercept-body .il span.k, .intercept-body .il span.s')).not.toBeNull();
    });

    it('counts matches across the headers and the body as one list', () => {
      // "3 of 7" has to mean the third thing down the panel, not the third in whichever section
      // happened to be counted first.
      open(jsonChange);

      component.query.set('supplier');
      fixture.detectChanges();

      // x-supplier appears in both header rows, "supplier" in both body lines.
      expect(component.matchLabel()).toBe('1/4');
    });

    it('steps through matches and wraps around', () => {
      open(jsonChange);
      component.query.set('supplier');
      fixture.detectChanges();

      component.step(1);
      expect(component.matchLabel()).toBe('2/4');

      component.step(-1);
      component.step(-1);
      expect(component.matchLabel()).toBe('4/4');
    });

    it('says so rather than showing 0/0 when nothing matches', () => {
      open(jsonChange);
      component.query.set('nothing-like-this');
      fixture.detectChanges();

      expect(component.matchLabel()).toBe('no matches');
      expect(component.activeMatch()).toBe(-1);
    });

    it('searches the view on screen, not the half that is hidden', () => {
      // Searching a side nobody is looking at would report matches that cannot be found.
      open(jsonChange);
      component.query.set('amadeus');
      fixture.detectChanges();
      const inDiff = component.matchLabel();

      component.show('final');
      fixture.detectChanges();

      expect(inDiff).not.toBe('no matches');
      expect(component.matchLabel()).toBe('no matches');
    });

    it('keeps the query but not the position when the view changes', () => {
      open(jsonChange);
      component.query.set('supplier');
      component.step(1);
      fixture.detectChanges();

      component.show('original');
      fixture.detectChanges();

      expect(component.query()).toBe('supplier');
      expect(component.matchLabel()).toBe('1/2');
    });

    it('still highlights a plain-text body, which has no tokens to highlight', () => {
      open({
        applied,
        originalResponse: { status: 200, headers: {}, body: 'grant_type=client_credentials' },
        finalResponse: { status: 200, headers: {}, body: 'grant_type=password' },
      });

      component.query.set('grant');
      fixture.detectChanges();

      expect(component.matchLabel()).toBe('1/2');
      expect(fixture.nativeElement.querySelector('.intercept-body mark.hl')).not.toBeNull();
    });

    it('copies the status change and the headers, not only the body', () => {
      // "200 → 500" is the headline of most of these panels; a copy that dropped it would drop
      // the reason somebody opened the panel in the first place.
      open(jsonChange);
      component.copy();

      expect(copied).toContain('200 OK → 500 Internal Server Error');
      expect(copied).toContain('x-supplier');
      expect(copied).toContain('"total"');
      expect(copied).toMatch(/^[-+] /m);
    });

    it('copies a single side without diff markers, ready to replay', () => {
      open(jsonChange);
      component.show('original');
      fixture.detectChanges();
      component.copy();

      expect(copied).not.toMatch(/^[-+] /m);
      expect(copied).toContain('amadeus');
      expect(copied).not.toContain('sabre');
    });

    it('confirms a copy happened rather than leaving the button silent', async () => {
      open(jsonChange);
      expect(component.copyLabel()).toBe('⧉ Copy diff');

      component.copy();
      await fixture.whenStable();

      expect(component.copied()).toBeTrue();
      expect(component.copyLabel()).toBe('✓ Copied');
    });

    it('reports the size of what is on screen', () => {
      open(jsonChange);

      expect(component.bodyStats()).toContain('lines');
      expect(component.monochrome()).toBeFalse();
    });
  });
});
