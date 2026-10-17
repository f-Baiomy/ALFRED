import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { CallRecord } from '../../../core/models/call.model';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { BoardCallsComponent, boardCallRows, pathOf } from './board-calls.component';

function call(id: string, at: string, opts: Partial<{ status: number; source: 'internal' | 'external'; error: string; url: string }> = {}): CallRecord {
  return { id, original_url: opts.url ?? 'http://app/api/' + id, url: opts.url ?? 'http://app/api/' + id, method: 'GET', timestamp: at, duration_ms: 10,
    response: opts.status != null ? { status: opts.status } : undefined, error: opts.error, source: opts.source ?? 'internal' } as unknown as CallRecord;
}

const CYCLES = [{ id: 'c1', name: 'login-flow', status: 'PAUSED' as const }, { id: 'c2', name: 'retest', status: 'RECORDING' as const }];

describe('board Calls tab (specs/029)', () => {
  const byCycle = new Map([
    ['c1', [call('a', '2026-10-15T10:00:00Z', { status: 200 }), call('b', '2026-10-15T10:01:00Z', { status: 500 })]],
    ['c2', [call('c', '2026-10-16T09:00:00Z', { status: 200, source: 'external' }), call('d', '2026-10-16T09:05:00Z', { error: 'reset' })]],
  ]);
  const all = { cycle: null, q: '', dir: 'all' as const, problems: false, grouped: false };

  it('lists every cycle newest first, or grouped by cycle, and filters', () => {
    expect(boardCallRows(byCycle, CYCLES, all).map((r) => r.call.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(boardCallRows(byCycle, CYCLES, { ...all, grouped: true }).map((r) => r.call.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(boardCallRows(byCycle, CYCLES, { ...all, cycle: 'c1' }).map((r) => r.call.id)).toEqual(['b', 'a']);
    expect(boardCallRows(byCycle, CYCLES, { ...all, problems: true }).map((r) => r.call.id)).toEqual(['d', 'b']);
    expect(boardCallRows(byCycle, CYCLES, { ...all, dir: 'out' }).map((r) => r.call.id)).toEqual(['c']);
    expect(boardCallRows(byCycle, CYCLES, { ...all, q: '500' }).map((r) => r.call.id)).toEqual(['b']);
    expect(pathOf('http://h:8080/api/x?y=1')).toBe('/api/x?y=1');
    expect(pathOf('not a url')).toBe('not a url');
  });

  it('reads each cycle, shows a divider between cycles and opens a call in the popup', () => {
    const mentions = { cycleCalls: jasmine.createSpy('cycleCalls').and.callFake((id: string) => of(byCycle.get(id) ?? [])),
      callToShow: { set: jasmine.createSpy('set') } };
    TestBed.configureTestingModule({
      imports: [BoardCallsComponent],
      providers: [{ provide: BoardMentionsService, useValue: mentions }, { provide: SessionCyclesStateService, useValue: { contentChanged$: new Subject<string>() } }],
    });
    const f = TestBed.createComponent(BoardCallsComponent);
    f.componentRef.setInput('cycles', CYCLES);
    f.detectChanges();
    f.detectChanges(); // the effect reads, then the rows render
    const el = f.nativeElement as HTMLElement;
    expect(mentions.cycleCalls).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll('.bc-row').length).toBe(4);
    expect(el.querySelectorAll('.bc-gap').length).toBe(1);
    expect(el.textContent).toContain('All cycles · 4');
    (el.querySelector('.bc-row') as HTMLElement).click();
    expect(mentions.callToShow.set).toHaveBeenCalledWith(jasmine.objectContaining({ callId: 'd', cycleId: 'c2', direction: 'in' }));
  });
});
