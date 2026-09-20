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
});
