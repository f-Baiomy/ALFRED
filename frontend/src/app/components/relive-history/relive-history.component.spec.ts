import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { FullRun, RECORDING_SIDE } from '../../shared/utils/relive-run-compare';
import { cmpResult, cmpRun, cmpStep } from '../../shared/utils/relive-run-compare.testing';
import { Run } from '../../shared/utils/relive-types';
import { NoiseChange } from '../relive-run-timeline/relive-run-timeline.component';
import { ReliveHistoryComponent } from './relive-history.component';

const steps = [cmpStep('login', { label: 'Login' }), cmpStep('pax', { label: 'Pax details' })];
const full: Record<string, FullRun> = {
  r3: cmpRun('r3', '2026-10-02T16:16:00Z', steps, [cmpResult('login', 'COMPLETED', { status: 200 }), cmpResult('pax', 'FAILED', { status: 500, body: '{"m":"x"}' })]),
  r2: cmpRun('r2', '2026-10-02T15:40:00Z', steps, [cmpResult('login', 'COMPLETED', { status: 200 }), cmpResult('pax', 'COMPLETED', { status: 200 })]),
  r1: cmpRun('r1', '2026-10-01T11:20:00Z', steps, [cmpResult('login', 'COMPLETED', { status: 200 }), cmpResult('pax', 'COMPLETED', { status: 200 })]),
};

function summary(run: FullRun): Run {
  const { stepResults: _results, secrets: _secrets, ...rest } = run;
  return rest;
}

describe('ReliveHistoryComponent', () => {
  let fixture: ComponentFixture<ReliveHistoryComponent>;
  let listRunsSpy: jasmine.Spy;
  let getRunSpy: jasmine.Spy;
  let el: HTMLElement;

  beforeEach(() => {
    listRunsSpy = jasmine.createSpy('listRuns').and.returnValue(of([full['r3'], full['r2'], full['r1']].map(summary)));
    getRunSpy = jasmine.createSpy('getRun').and.callFake((_cycleId: string, runId: string) => of(full[runId]));
    TestBed.configureTestingModule({
      imports: [ReliveHistoryComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ReliveApiService, useValue: { listRuns: listRunsSpy, getRun: getRunSpy, listLiveCalls: () => of({ calls: [], totalBytes: 0 }) } },
      ],
    });
    fixture = TestBed.createComponent(ReliveHistoryComponent);
    fixture.componentRef.setInput('cycleId', 'c-1');
    fixture.componentRef.setInput('steps', steps);
    fixture.detectChanges();
    el = fixture.nativeElement;
  });

  const cellsOf = (stepKey: string) => Array.from(el.querySelectorAll(`[data-cell^="${stepKey}|"]`)).map((c) => c.textContent?.trim());

  it('loads the runs, newest first, and each one in full for the matrix', () => {
    expect(listRunsSpy).toHaveBeenCalledWith('c-1');
    expect(fixture.componentInstance.runs().map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(getRunSpy).toHaveBeenCalledWith('c-1', 'r1');
    expect(Array.from(el.querySelectorAll('[data-run]')).map((h) => h.getAttribute('data-run'))).toEqual(['r3', 'r2', 'r1']);
  });

  it('draws one row per step, one cell per run, and says what stands out', () => {
    expect(cellsOf('login')).toEqual(['✓', '✓', '✓']);
    expect(cellsOf('pax')).toEqual(['✗', '✓', '✓']);
    expect(el.textContent).toContain('first failure in 3 runs');
  });

  it('compares the newest run (B) with the one before it (A) by default, right under the matrix', () => {
    expect(fixture.componentInstance.bId()).toBe('r3');
    expect(fixture.componentInstance.aId()).toBe('r2');
    expect(el.querySelector('app-relive-run-compare .rl-cmp-verdict')?.textContent).toContain('B is worse:');
  });

  it('the A / B buttons on a column pick the runs compared', () => {
    fixture.componentInstance.makeA('r1');
    fixture.detectChanges();
    expect(fixture.componentInstance.aId()).toBe('r1');
    expect(el.querySelector('[data-run="r1"]')?.classList).toContain('rl-mx-a');
    fixture.componentInstance.makeB('r1');
    expect(fixture.componentInstance.bId()).toBe('r1');
    expect(fixture.componentInstance.aId()).toBe('r3');
  });

  it('a cell of A or B keeps the pair and opens the step below', () => {
    (el.querySelector('[data-cell="pax|r2"]') as HTMLElement).click();
    fixture.detectChanges();
    expect([fixture.componentInstance.aId(), fixture.componentInstance.bId()]).toEqual(['r2', 'r3']);
    expect(fixture.componentInstance.focus()).toEqual({ key: 'pax' });
  });

  it('any other cell compares that run with the one before it (the recording for the oldest)', () => {
    fixture.componentInstance.makeA('r3');
    fixture.componentInstance.makeB('r2');
    fixture.detectChanges();
    (el.querySelector('[data-cell="login|r1"]') as HTMLElement).click();
    expect([fixture.componentInstance.aId(), fixture.componentInstance.bId()]).toEqual([RECORDING_SIDE, 'r1']);
  });

  it('"Compare with the recording" makes the recording side A', () => {
    fixture.componentInstance.compareWithRecording('r2');
    fixture.detectChanges();
    expect(fixture.componentInstance.aId()).toBe(RECORDING_SIDE);
    expect(el.querySelector('app-relive-run-compare .rl-cmp-side')?.textContent).toContain('The recording');
  });

  it('shows the newest runs first and older ones on request', () => {
    const many = Array.from({ length: 9 }, (_, i) => cmpRun(`m${i}`, `2026-09-${10 + i}T10:00:00Z`, steps, []));
    listRunsSpy.and.returnValue(of(many.map(summary)));
    getRunSpy.and.callFake((_c: string, id: string) => of(many.find((r) => r.id === id)));
    fixture = TestBed.createComponent(ReliveHistoryComponent);
    fixture.componentRef.setInput('cycleId', 'c-1');
    fixture.detectChanges();
    expect(fixture.componentInstance.columnRuns().length).toBe(6);
    fixture.componentInstance.showOlder();
    fixture.detectChanges();
    expect(fixture.componentInstance.columnRuns().length).toBe(9);
  });

  it('"Ignore in cycle" in the comparison becomes a cycle noise rule', () => {
    let change: NoiseChange | undefined;
    fixture.componentInstance.noiseChange.subscribe((c) => (change = c));
    fixture.componentInstance.onIgnore({ stepKey: 'pax', rule: { part: 'body', path: 'body.m', auto: false, count: false } });
    expect(change).toEqual({ stepKey: 'pax', scope: 'CYCLE', remove: false, rule: { part: 'body', path: 'body.m', auto: false, count: false } });
  });

  it('T072: "Open" emits the run id', () => {
    let opened: string | null = null;
    fixture.componentInstance.openRun.subscribe((id) => (opened = id));
    fixture.componentInstance.open(summary(full['r1']));
    expect(opened!).toBe('r1');
  });

  it('T079: exportRun() fetches the full run and downloads a report without throwing', () => {
    expect(() => fixture.componentInstance.exportRun(summary(full['r1']), 'markdown')).not.toThrow();
    expect(getRunSpy).toHaveBeenCalledWith('c-1', 'r1');
  });
});
