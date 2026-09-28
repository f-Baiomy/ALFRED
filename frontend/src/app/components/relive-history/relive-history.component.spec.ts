import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { Run } from '../../shared/utils/relive-types';
import { ReliveHistoryComponent } from './relive-history.component';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    cycleId: 'c-1',
    driver: 'AUTOMATIC',
    status: 'COMPLETED',
    startedAt: '2026-09-27T10:00:00Z',
    finishedAt: '2026-09-27T10:00:30Z',
    definition: {} as Run['definition'],
    seedVariables: [],
    variableTimeline: [],
    summary: { total: 3, completed: 3, different: 0, failed: 0, skipped: 0, notCalled: 0, cancelled: 0, live: 1, replayed: 2, unattributed: 0 },
    resumed: [],
    log: [],
    ...overrides,
  };
}

describe('ReliveHistoryComponent', () => {
  let fixture: ComponentFixture<ReliveHistoryComponent>;
  let listRunsSpy: jasmine.Spy;
  let getRunSpy: jasmine.Spy;

  beforeEach(() => {
    listRunsSpy = jasmine.createSpy('listRuns').and.returnValue(of([run('r-2', { startedAt: '2026-09-27T11:00:00Z' }), run('r-1')]));
    getRunSpy = jasmine.createSpy('getRun');
    TestBed.configureTestingModule({
      imports: [ReliveHistoryComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: ReliveApiService, useValue: { listRuns: listRunsSpy, getRun: getRunSpy } }],
    });
    fixture = TestBed.createComponent(ReliveHistoryComponent);
    fixture.componentRef.setInput('cycleId', 'c-1');
  });

  it('loads the runs list for the cycle, newest first as the backend returns it', () => {
    fixture.detectChanges();
    expect(listRunsSpy).toHaveBeenCalledWith('c-1');
    expect(fixture.componentInstance.runs().map((r) => r.id)).toEqual(['r-2', 'r-1']);
  });

  it('T072: "Open" emits the run id', () => {
    fixture.detectChanges();
    let opened: string | null = null;
    fixture.componentInstance.openRun.subscribe((id) => (opened = id));

    fixture.componentInstance.open(run('r-1'));

    expect(opened!).toBe('r-1');
  });

  it('T072: "Compare with newest" fetches both runs and adapts them for ScenarioRunCompareComponent', () => {
    fixture.detectChanges();
    getRunSpy.and.callFake((cycleId: string, runId: string) =>
      of({ ...run(runId), stepResults: [{ runId, stepKey: 's-1', attempt: 1, state: 'COMPLETED', mode: 'REPLAY', attribution: 'HEADER', differences: [], rulesApplied: [], variablesUsed: [], variablesProduced: [], unexpectedCalls: [], pauses: [], durationMs: 42, actualResponse: { status: 200, headers: {}, body: '{}' } }], secrets: [] }),
    );

    fixture.componentInstance.compareWithNewest(run('r-1'));

    expect(getRunSpy).toHaveBeenCalledWith('c-1', 'r-1');
    expect(getRunSpy).toHaveBeenCalledWith('c-1', 'r-2');
    const compared = fixture.componentInstance.compareRuns();
    expect(compared!.map((r) => r.id)).toEqual(['r-1', 'r-2']);
    expect(compared![0].results!.draftResults[0].status).toBe(200);
  });
});
