import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogTimePanelComponent, TimeRange } from './log-time-panel.component';

const NEWEST = Date.UTC(2026, 9, 4, 14, 0, 0);
const OLDEST = Date.UTC(2026, 9, 1, 0, 0, 0);
const MIN = 60_000;

describe('LogTimePanelComponent (time range picker)', () => {
  beforeEach(() => {
    localStorage.removeItem('alfred.logs.recentRanges.s1');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LogsApiService,
          useValue: {
            lines: () => of({ lines: [], total: 7 }),
            histogram: () => of({ from: 0, to: 0, bucketMs: 1, buckets: [] }),
          },
        },
      ],
    });
  });

  function make(current: TimeRange | null = null) {
    const f = TestBed.createComponent(LogTimePanelComponent);
    f.componentRef.setInput('sourceId', 's1');
    f.componentRef.setInput('oldest', OLDEST);
    f.componentRef.setInput('newest', NEWEST);
    f.componentRef.setInput('current', current);
    f.detectChanges();
    const out: (TimeRange | null)[] = [];
    f.componentInstance.apply.subscribe((r) => out.push(r));
    return { f, c: f.componentInstance, out };
  }

  it('a quick range is applied as that preset (counted back from the newest line)', () => {
    const { c, out } = make();
    c.quick('1h');
    expect(c.from()).toBe(NEWEST - 60 * MIN);
    c.doApply();
    expect(out).toEqual([{ preset: '1h' }]);
  });

  it('To follows From until To is set; after that they move apart', () => {
    const { c } = make();
    c.set('from', NEWEST - 30 * MIN);
    expect(c.to()).toBe(NEWEST - 30 * MIN);
    c.set('to', NEWEST);
    c.set('from', NEWEST - 50 * MIN);
    expect(c.to()).toBe(NEWEST);
  });

  it('the length lock moves both sides by the same amount', () => {
    const { c } = make({ from: NEWEST - 10 * MIN, to: NEWEST });
    c.toggleLock();
    c.set('from', NEWEST - 70 * MIN);
    expect(c.to()! - c.from()!).toBe(10 * MIN);
    expect(c.to()).toBe(NEWEST - 60 * MIN);
  });

  it('stepping and "around From" keep the length and center', () => {
    const { c } = make({ from: NEWEST - 10 * MIN, to: NEWEST });
    c.stepWindow(-1);
    expect([c.from(), c.to()]).toEqual([NEWEST - 20 * MIN, NEWEST - 10 * MIN]);
    c.around(5);
    expect([c.from(), c.to()]).toEqual([NEWEST - 25 * MIN, NEWEST - 15 * MIN]);
  });

  it('"To = now, keep moving" applies an open end; a custom range is remembered as recent', () => {
    const { c, out } = make({ from: NEWEST - 10 * MIN, to: NEWEST });
    c.doApply();
    c.live.set(true);
    c.doApply();
    expect(out).toEqual([{ from: NEWEST - 10 * MIN, to: NEWEST }, { from: NEWEST - 10 * MIN, to: null }]);
    expect(JSON.parse(localStorage.getItem('alfred.logs.recentRanges.s1')!)).toEqual([{ from: NEWEST - 10 * MIN, to: NEWEST }]);
  });

  it('From after To cannot be applied', () => {
    const { c, out } = make({ from: NEWEST, to: NEWEST - MIN });
    expect(c.bad()).toBeTrue();
    c.doApply();
    expect(out).toEqual([]);
  });
});
