import { TestBed } from '@angular/core/testing';
import { BoardStage } from '../../../core/models/board.models';
import { SyncResult } from '../../../core/team/team.models';
import { StageStripComponent, refreshLine } from './stage-strip.component';

const COUNTS = { brief: true, items: 3, inbox: 0, waitingOnUser: 0, toDo: 0, inProgress: 0, fixed: 0, untested: 0, failing: 0, unmarked: 0 };
const at = (stage: BoardStage['stage']): BoardStage => ({ stage, ref: 'AB#61813', counts: COUNTS, next: 'x' });

describe('StageStripComponent (specs/032)', () => {
  function render(stage: BoardStage | null, phase: number | null = 1) {
    const f = TestBed.createComponent(StageStripComponent);
    f.componentRef.setInput('stage', stage);
    f.componentRef.setInput('phase', phase);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('marks the stages before as done, the current with its number, and says nothing about the next step', () => {
    const el = render(at('TRIAGE'));
    const stg = Array.from(el.querySelectorAll('.stg'));
    expect(stg.map((s) => s.textContent!.trim())).toEqual(['✓Board', '✓Define', '3Triage', '4Code', '5Verify', '6Test', '7Close']);
    expect(el.querySelector('.stg.now')!.textContent).toContain('Triage');
    expect(el.querySelectorAll('.stg.done').length).toBe(2);
    expect(el.querySelectorAll('.line.done').length).toBe(2);
    expect(el.textContent).not.toContain('Next');
    expect(el.querySelector('button')).toBeNull();
  });

  it('shows the Coded → Done ladder only from Code on', () => {
    expect(render(at('DEFINE')).querySelector('.ladder')).toBeNull();
    expect(render(at('TRIAGE')).querySelector('.ladder')).toBeNull();
    for (const s of ['CODE', 'VERIFY', 'TEST', 'CLOSE'] as const) {
      const ladder = render(at(s), 2).querySelector('.ladder')!;
      expect(ladder).withContext(s).not.toBeNull();
      expect(ladder.querySelector('.now')!.textContent).toContain('Fixed');
    }
    expect(render(at('CODE'), null).querySelector('.ladder')).toBeNull();
  });

  it('renders nothing without a stage (the default board)', () => {
    expect(render(null).querySelector('.stages')).toBeNull();
  });

  it('words a refresh in one line', () => {
    expect(refreshLine({ changed: 0, newInTree: 1, leftTree: 0, matches: 2, changedItems: [{ newComments: 1 }] } as unknown as SyncResult))
      .toBe('1 changed · 1 new comment · 1 new in the tree (in Incoming) · 2 possible card matches');
    expect(refreshLine({ changed: 0, newInTree: 0, leftTree: 0, matches: 0 } as unknown as SyncResult)).toBe('No changes in Azure');
  });
});
