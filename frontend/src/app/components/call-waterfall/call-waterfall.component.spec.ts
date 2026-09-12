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

    const rootClose = lines[4].querySelector('.waterfall-bar') as HTMLElement;
    expect(parseFloat(rootClose.style.width)).toBeCloseTo(100, 3);
    // core-service starts 2s into odeysys's 10s and runs 4s of it.
    const coreClose = lines[3].querySelector('.waterfall-bar') as HTMLElement;
    expect(parseFloat(coreClose.style.marginLeft)).toBeCloseTo(20, 3);
    expect(parseFloat(coreClose.style.width)).toBeCloseTo(40, 3);
  });

  it('expands the full call card on click, and collapses it again', () => {
    const fixture = createWaterfall();
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('app-call-card')).toBeNull();

    (host.querySelectorAll('.waterfall-row')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelectorAll('app-call-card').length).toBe(1);

    (host.querySelectorAll('.waterfall-row')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('app-call-card')).toBeNull();
  });

  it('shows an error row without a duration rather than a bogus timing', () => {
    const failed = [call('solo', 0, 0, { source: 'external', error: 'boom', response: undefined })];
    const host: HTMLElement = createWaterfall(failed).nativeElement;

    expect(host.querySelector('.status-err')?.textContent).toContain('ERROR');
    expect(host.querySelector('.waterfall-duration')?.textContent).toContain('err');
  });
});
