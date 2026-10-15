import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { RetestCheck } from '../models/board.models';
import { BoardApiService } from './board-api.service';
import { ConfirmDialogService } from './confirm-dialog.service';
import { VerifyGuardService } from './verify-guard.service';

function check(emptyAnswers: number, calls = 2): RetestCheck {
  return { number: 44, project: 'p', title: 't', status: 'FIXED', since: null, verdict: 'PASSES', statusOnly: false, summary: 's', results: [],
    calls: Array.from({ length: calls }, (_, i) => ({ ref: `in:${i}`, label: 'l', at: null, passed: true, failed: null })), steps: [], newBuild: false, emptyAnswers };
}

describe('VerifyGuardService (specs/020)', () => {
  let chosen: string | null;
  let api: { cardRetest: jasmine.Spy; retestRun: jasmine.Spy; comment: jasmine.Spy };

  function make(c: RetestCheck): VerifyGuardService {
    api = { cardRetest: jasmine.createSpy().and.returnValue(of({ check: c })), retestRun: jasmine.createSpy().and.returnValue(of({})),
      comment: jasmine.createSpy().and.returnValue(of({})) };
    TestBed.configureTestingModule({ providers: [
      { provide: BoardApiService, useValue: api },
      { provide: ConfirmDialogService, useValue: { choose: () => Promise.resolve(chosen) } },
    ] });
    return TestBed.inject(VerifyGuardService);
  }

  it('moves at once when the re-test saw rows', async () => {
    const move = jasmine.createSpy('move');
    expect(await make(check(1)).verify({ id: 'k', number: 44, project: 'p' }, move)).toBe('moved');
    expect(move).toHaveBeenCalled();
  });

  it('asks when every answer was empty: keep, ask Claude, or verify anyway after recording the re-test', async () => {
    const move = jasmine.createSpy('move');
    chosen = null;
    expect(await make(check(2)).verify({ id: 'k', number: 44, project: 'p' }, move)).toBe('kept');
    expect(move).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    chosen = 'ask';
    expect(await make(check(2)).verify({ id: 'k', number: 44, project: 'p' }, move)).toBe('asked');
    expect(api.comment.calls.mostRecent().args[1]).toContain('every re-test answer so far was empty (2 calls, 0 rows)');
    TestBed.resetTestingModule();
    chosen = 'anyway';
    expect(await make(check(2)).verify({ id: 'k', number: 44, project: 'p' }, move)).toBe('moved');
    expect(api.retestRun).toHaveBeenCalledWith('p', [44], null);
    expect(move).toHaveBeenCalled();
  });
});
