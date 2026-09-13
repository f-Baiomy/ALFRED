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
    const rails = Array.from(host.querySelectorAll('.waterfall-rail')) as HTMLElement[];

    expect(parseFloat(rails[0].style.width || '0')).toBe(0);
    expect(parseFloat(rails[1].style.width)).toBeGreaterThan(0);
    expect(parseFloat(rails[2].style.width)).toBeGreaterThan(parseFloat(rails[1].style.width));
    // The closing rows sit back at their own call's depth, level with their openers.
    expect(rails[3].style.width).toBe(rails[1].style.width);
    expect(rails[4].style.width || '0px').toBe(rails[0].style.width || '0px');

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
