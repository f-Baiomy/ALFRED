import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallWaterfallComponent } from './call-waterfall.component';
import { CallRecord } from '../../core/models/call.model';
import { buildCallTree, indexCallTree } from '../../shared/utils/call-tree';
import { CallsStateService } from '../../core/state/calls-state.service';
import { BULK_SELECTION_STATE, CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(id: string, startMs: number, durationMs: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: `http://localhost/${id}`,
    url: `http://host/${id}/path`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 },
    source: 'internal',
    state: 'COMPLETED',
    ...overrides,
  };
}

/** odeysys (0 -> 10s) containing core-service (2s -> 4s) containing one supplier call. */
const CALLS: CallRecord[] = [
  call('odeysys', 0, 10000, { service_name: 'odeysys' }),
  call('core', 2000, 4000, { service_name: 'core-service' }),
  call('sabre', 2500, 1000, { source: 'external', service_name: 'core-service' }),
];

describe('CallWaterfallComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };
    await TestBed.configureTestingModule({
      imports: [CallWaterfallComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CALL_SELECTION_STATE, useExisting: CallsStateService },
        { provide: BULK_SELECTION_STATE, useExisting: CallsStateService },
        { provide: CALL_LIST_CONTROLS_STATE, useExisting: CallsStateService },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.match(() => true).forEach((req) => req.flush({ calls: [], total: 0 }));
    httpMock.verify();
  });

  function createWaterfall(calls: CallRecord[] = CALLS) {
    const fixture = TestBed.createComponent(CallWaterfallComponent);
    fixture.componentRef.setInput('nodes', buildCallTree(calls));
    fixture.componentRef.setInput('depths', indexCallTree(calls));
    fixture.detectChanges();
    return fixture;
  }

  it('brackets every call that called others, and leaves a childless call as one row', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const rows = Array.from(host.querySelectorAll('.waterfall-line'));

    // odeysys opens, core-service opens, the supplier call sits alone, then both close in turn.
    expect(rows.length).toBe(5);
    expect(rows.map((r) => (r.classList.contains('waterfall-open') ? 'open' : r.classList.contains('waterfall-close') ? 'close' : 'single'))).toEqual([
      'open',
      'open',
      'single',
      'close',
      'close',
    ]);

    const labels = Array.from(host.querySelectorAll('.waterfall-label')).map((el) => el.textContent?.trim());
    expect(labels[0]).toContain('odeysys');
    expect(labels[1]).toContain('core-service');
    expect(labels[2]).toContain('path');
    // The closing rows name the same calls as their openers.
    expect(labels[3]).toContain('core-service');
    expect(labels[4]).toContain('odeysys');
  });

  it('marks which half each bracketing row is, and keeps the status on the closing one', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const rows = Array.from(host.querySelectorAll('.waterfall-line'));

    expect(rows[0].querySelector('.band-marker')?.textContent).toContain('request');
    expect(rows[0].querySelector('.status-sent')).toBeTruthy();
    expect(rows[0].querySelector('.waterfall-duration')?.textContent?.trim()).toBe('sent');

    expect(rows[4].querySelector('.band-marker')?.textContent).toContain('response');
    expect(rows[4].querySelector('.waterfall-duration')?.textContent).toContain('10000');
    // A childless row keeps its method badge and carries no half marker at all.
    expect(rows[2].querySelector('.band-marker')).toBeNull();
    expect(rows[2].textContent).toContain('POST');
  });

  it('indents each level and measures every bar against the root call\'s window', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    // A row's indent is now the sum of its guide lines, one per ancestor level plus its own.
    const indents = Array.from(host.querySelectorAll('.waterfall-line')).map((line) =>
      Array.from(line.querySelectorAll('.waterfall-rail')).reduce(
        (total, rail) => total + parseFloat((rail as HTMLElement).style.width || '0'),
        0
      )
    );

    expect(indents[0]).toBe(0);
    expect(indents[1]).toBeGreaterThan(0);
    expect(indents[2]).toBeGreaterThan(indents[1]);
    // The closing rows sit back at their own call's depth, level with their openers.
    expect(indents[3]).toBe(indents[1]);
    expect(indents[4]).toBe(indents[0]);

    // Only a CLOSING (or childless) row draws a span; an opening row is a start tick trailing off.
    const lines = Array.from(host.querySelectorAll('.waterfall-line'));
    expect(lines[0].querySelector('.waterfall-bar')).toBeNull();
    expect(lines[0].querySelector('.waterfall-tick')).toBeTruthy();
    expect(lines[0].querySelector('.waterfall-pending')).toBeTruthy();

    // The childless supplier call draws one plain bar: 0.5s into a 10s root, running 1s of it.
    const leaf = lines[2].querySelector('.waterfall-bar') as HTMLElement;
    expect(parseFloat(leaf.style.marginLeft)).toBeCloseTo(25, 3);
    expect(parseFloat(leaf.style.width)).toBeCloseTo(10, 3);
  });

  it('splits a parent\'s closing bar into what it waited on and what it did itself', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const lines = Array.from(host.querySelectorAll('.waterfall-line'));

    // odeysys runs the whole 10s root: 2s before core-service started, 4s waiting on it, 4s after.
    const rootSegments = Array.from(lines[4].querySelectorAll('.waterfall-bar')) as HTMLElement[];
    expect(rootSegments.length).toBe(3);
    expect(parseFloat(rootSegments[0].style.width)).toBeCloseTo(20, 3);
    expect(parseFloat(rootSegments[1].style.width)).toBeCloseTo(40, 3);
    expect(parseFloat(rootSegments[2].style.width)).toBeCloseTo(40, 3);
    // Only the middle stretch is "waiting" - the two ends are the call's own work.
    expect(rootSegments[0].classList).toContain('waterfall-self');
    expect(rootSegments[1].classList).not.toContain('waterfall-self');
    expect(rootSegments[2].classList).toContain('waterfall-self');

    // Spelled out in words on hover rather than needing a legend above every group.
    expect(lines[4].querySelector('.waterfall-duration')?.getAttribute('title')).toBe(
      '4000 ms waiting on nested calls, 6000 ms of its own work'
    );
  });

  it('prints how far into the root each call started, at millisecond resolution', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const offsets = Array.from(host.querySelectorAll('.waterfall-offset')).map((el) => el.textContent?.trim());

    // The root opens at zero; core-service 2s in; the supplier call 500ms after that. A closing row
    // reports when the group FINISHED, not when it started.
    expect(offsets[0]).toBe('+0ms');
    expect(offsets[1]).toBe('+2.00s');
    expect(offsets[2]).toBe('+2.50s');
    expect(offsets[3]).toBe('+6.00s');
    expect(offsets[4]).toBe('+10.00s');
  });

  it('draws one axis per group, on its opening row only, labelled with that root\'s own total', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const lines = Array.from(host.querySelectorAll('.waterfall-line'));

    expect(lines[0].querySelector('.waterfall-axis')).toBeTruthy();
    expect(lines[0].querySelector('.waterfall-axis-end')?.textContent?.trim()).toBe('+10.00s');
    // A nested group shares its root's scale, so it doesn't draw a second, conflicting one.
    expect(lines[1].querySelector('.waterfall-axis')).toBeNull();
    expect(lines[4].querySelector('.waterfall-axis')).toBeNull();
  });

  it('marks a call with no measurable duration as a tick, not a floored sliver', () => {
    const failed = [
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('dead', 2000, 0, { source: 'external', error: 'boom', response: undefined }),
    ];
    const host: HTMLElement = createWaterfall(failed).nativeElement;
    const deadLine = Array.from(host.querySelectorAll('.waterfall-line'))[1];

    expect(deadLine.querySelector('.waterfall-bar')).toBeNull();
    const tick = deadLine.querySelector('.waterfall-tick') as HTMLElement;
    expect(tick.classList).toContain('waterfall-tick-error');
    expect(parseFloat(tick.style.marginLeft)).toBeCloseTo(20, 3);
  });

  it('expands the full call card on click, and collapses it again', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('app-call-card')).toBeNull();

    (host.querySelectorAll('.waterfall-row-main')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelectorAll('app-call-card').length).toBe(1);

    (host.querySelectorAll('.waterfall-row-main')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('app-call-card')).toBeNull();
  });

  it('shows an error row without a duration rather than a bogus timing', () => {
    const failed = [call('solo', 0, 0, { source: 'external', error: 'boom', response: undefined })];
    const host: HTMLElement = createWaterfall(failed).nativeElement;

    expect(host.querySelector('.status-err')?.textContent).toContain('ERROR');
    expect(host.querySelector('.waterfall-duration')?.textContent).toContain('err');
  });

  it('offers one checkbox per call, not one per row, so a bracketed pair is selected once', () => {
    const host: HTMLElement = createWaterfall().nativeElement;

    // odeysys and core-service are each bracketed into two rows, sabre is one: 5 rows, 3 calls.
    expect(host.querySelectorAll('.waterfall-row').length).toBe(5);
    expect(host.querySelectorAll('.call-select').length).toBe(3);
    // The closing halves keep the checkbox's width as empty space, so both halves still line up.
    expect(host.querySelectorAll('.waterfall-select-spacer').length).toBe(2);
  });

  it('ticks a call through the shared selection state, so other views agree', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;
    const selection = TestBed.inject(CALL_SELECTION_STATE);

    (host.querySelector('.call-select') as HTMLInputElement).click();
    fixture.detectChanges();

    expect(selection.isSelected(CALLS[0])).toBe(true);
    expect((host.querySelector('.call-select') as HTMLInputElement).checked).toBe(true);
  });

  it('draws one guide line per ancestor level, each in that level\'s own hue', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const tintsPerLine = Array.from(host.querySelectorAll('.waterfall-line')).map((line) =>
      Array.from(line.querySelectorAll('.waterfall-rail')).map((rail) =>
        rail.className.replace('waterfall-rail ', '').replace(' waterfall-rail-own', '')
      )
    );

    // A depth-2 row shows all three levels, not just its own - a lone tick at an indent says how far
    // in a call sits but nothing about what it sits inside.
    expect(tintsPerLine).toEqual([
      ['depth-tint-0'],
      ['depth-tint-0', 'depth-tint-1'],
      ['depth-tint-0', 'depth-tint-1', 'depth-tint-2'],
      ['depth-tint-0', 'depth-tint-1'],
      ['depth-tint-0'],
    ]);
  });

  it('marks only the last guide line as the row\'s own level, so ancestors can be drawn back', () => {
    const host: HTMLElement = createWaterfall().nativeElement;
    const rails = Array.from(host.querySelectorAll('.waterfall-line')[2].querySelectorAll('.waterfall-rail'));

    expect(rails.map((r) => r.classList.contains('waterfall-rail-own'))).toEqual([false, false, true]);
  });

  it('offers a diagnose button on every call that made calls, and shows no panel until pressed', () => {
    const host: HTMLElement = createWaterfall().nativeElement;

    // odeysys called core-service, which called sabre - two callers, so two buttons. The middle one
    // is usually the interesting one: it is the service that actually did the fanning out.
    expect(host.querySelectorAll('.diag-btn').length).toBe(2);
    expect(host.querySelectorAll('.waterfall-line')[2].querySelector('.diag-btn')).toBeNull();
    expect(host.querySelector('app-call-diagnostics')).toBeNull();
  });

  it('opens the panel directly above its own row, and closes it again', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelectorAll('.diag-btn')[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    // The panel belongs to core-service's line, not to the root's, and sits directly before its row.
    const line = host.querySelectorAll('.waterfall-line')[1];
    expect(Array.from(line.children).map((el) => el.className.split(' ')[0])).toEqual(['waterfall-diag', 'waterfall-row']);
    expect(host.querySelectorAll('app-call-diagnostics').length).toBe(1);

    (host.querySelectorAll('.diag-btn')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('app-call-diagnostics')).toBeNull();
  });

  it('marks the row as joined to its panel, so the two share an edge', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelectorAll('.diag-btn')[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    const rows = host.querySelectorAll('.waterfall-row');
    expect(rows[0].classList).toContain('waterfall-row-diag');
    // Only the row the panel opened above - the rest keep their ordinary borders.
    expect(rows[1].classList).not.toContain('waterfall-row-diag');
  });

  it('pressing diagnose does not expand the row\'s call card', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelectorAll('.diag-btn')[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.querySelector('app-call-card')).toBeNull();
  });

  it('folds a group down to its bracket, counting what it hid', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelectorAll('.waterfall-line').length).toBe(5);

    // The outermost group's fold control - odeysys, the first opening row.
    (host.querySelectorAll('.fold-toggle')[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    // Its bracket survives (it carries the timing); everything between the halves is gone.
    expect(host.querySelectorAll('.waterfall-line').length).toBe(2);
    expect(host.querySelector('.waterfall-folded-count')!.textContent).toContain('2 folded');
  });

  it('only an opening row carries a fold control, and a childless row carries none', () => {
    const host: HTMLElement = createWaterfall().nativeElement;

    // Two bracketed calls, so two fold controls - not one per row, and none on the supplier leaf.
    expect(host.querySelectorAll('.fold-toggle').length).toBe(2);
    expect(host.querySelectorAll('.waterfall-line')[2].querySelector('.fold-toggle')).toBeNull();
    expect(host.querySelectorAll('.waterfall-fold-spacer').length).toBe(3);
  });

  it('unfolding restores one level, leaving the parents inside it folded', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelectorAll('.fold-toggle')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    (host.querySelectorAll('.fold-toggle')[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    // odeysys is open again; core-service came back folded, so its own two rows are all that's added.
    expect(host.querySelectorAll('.waterfall-line').length).toBe(4);
    expect(host.querySelector('.waterfall-folded-count')!.textContent).toContain('1 folded');
  });

  it('a row\'s checkbox takes the call and everything nested under it', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;
    const selection = TestBed.inject(CALL_SELECTION_STATE);
    const spy = spyOn(selection, 'setSubtreeSelected').and.callThrough();

    (host.querySelector('.call-select') as HTMLInputElement).click();

    expect(spy.calls.mostRecent().args[0].id).toBe('odeysys');
    expect(spy.calls.mostRecent().args[1]).toBe(true);
  });

  it('does not expand the row when the checkbox is clicked', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelector('.call-select') as HTMLInputElement).click();
    fixture.detectChanges();

    // Selecting and opening are separate intents - a checkbox inside the row button would have
    // done both at once.
    expect(host.querySelector('app-call-card')).toBeNull();
  });
});
