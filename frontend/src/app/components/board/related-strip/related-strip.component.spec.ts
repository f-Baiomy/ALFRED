import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { RelatedStripComponent } from './related-strip.component';

const S: BoardSummary = { board: { id: 'b1', project: 'odeysys', name: 'AB#1', isDefault: false, state: 'OPEN', migratedFrom: null, createdAt: '', updatedAt: '' },
  cards: 0, cycleIds: ['c1'], boardIds: [], linkedItem: null };
const OTHER: BoardSummary = { ...S, board: { ...S.board, id: 'b2', name: 'AB#2' }, cycleIds: ['c1'] };
const CYCLES = [{ id: 'c1', name: 'test run', status: 'RECORDING' }, { id: 'c2', name: 'old run', status: 'PAUSED' }] as unknown as SessionCycle[];

describe('RelatedStripComponent on the Cycles tab (specs/032 T047)', () => {
  function render() {
    const api = { relateCycle: jasmine.createSpy('relate').and.returnValue(of({})), relateBoard: jasmine.createSpy('relateBoard').and.returnValue(of({})) };
    TestBed.configureTestingModule({ imports: [RelatedStripComponent], providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BoardApiService, useValue: api }] });
    const f = TestBed.createComponent(RelatedStripComponent);
    f.componentRef.setInput('summary', S);
    f.componentRef.setInput('cycles', CYCLES);
    f.componentRef.setInput('allBoards', [S, OTHER]);
    f.detectChanges();
    return { f, api, el: f.nativeElement as HTMLElement };
  }

  it('shows the cycles with REC and shared · N, and no state buttons or Record (they are in the header)', () => {
    const { el } = render();
    const chip = el.querySelector('.related-chip.cyc')!;
    expect(chip.textContent).toContain('test run');
    expect(chip.textContent).toContain('REC');
    expect(chip.textContent).toContain('shared · 1');
    expect(el.textContent).not.toContain('● Record');
    expect(el.textContent).not.toContain('Delete…');
  });

  it('unrelates and relates cycles; a cycle name opens its verdicts', () => {
    const { f, api, el } = render();
    (el.querySelector('.related-x') as HTMLButtonElement).click();
    expect(api.relateCycle).toHaveBeenCalledWith('b1', 'c1', false);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('relate cycle or board')) as HTMLButtonElement).click();
    f.detectChanges();
    (Array.from(el.querySelectorAll('.related-pick-row button')).find((b) => b.textContent?.includes('Relate')) as HTMLButtonElement).click();
    expect(api.relateCycle).toHaveBeenCalledWith('b1', 'c2', true);
    (el.querySelector('.related-open') as HTMLButtonElement).click();
    f.detectChanges();
    expect(f.componentInstance.verdictsOf()?.id).toBe('c1');
  });
});
