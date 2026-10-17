import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SearchResult, SearchRow } from '../../../core/team/team.models';
import { RowAction, TeamResultsTableComponent } from './results-table.component';

const ROW: SearchRow = {
  id: '42', type: 'Bug', title: 'Refund fails', state: 'Active', stateCategory: 'InProgress', assigned: { extId: 'p1', name: 'Sara', email: 'sara@x' },
  iteration: 'Shop\\Sprint 4', area: 'Shop', changedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), rev: 3, url: null,
  boards: [{ boardId: 'b1', name: 'Refunds', role: 'MAIN', copyRev: 2, changed: true }], cards: [],
};

describe('TeamResultsTableComponent (specs/028 US1)', () => {
  function setUp(result: SearchResult) {
    TestBed.configureTestingModule({
      imports: [TeamResultsTableComponent],
      providers: [
        { provide: TeamStateService, useValue: { ui: () => ({ word: (w: string) => w }), picked: () => ({ id: 'c1' }), me: signal(null), personOf: () => null } },
        { provide: TeamApiService, useValue: {} },
      ],
    });
    const f = TestBed.createComponent(TeamResultsTableComponent);
    f.componentRef.setInput('result', result);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  it('shows the main badge with "changed since the saved copy", the iteration name and the age', () => {
    const { el } = setUp({ items: [ROW], total: 1, fullText: true, page: 0, pageSize: 50 });
    const badge = el.querySelector('.trt-badge.main') as HTMLElement;
    expect(badge.textContent).toContain('Refunds');
    expect(badge.classList).toContain('changed');
    expect(el.textContent).toContain('Sprint 4');
    expect(el.textContent).toContain('2 h');
    expect(el.querySelector('.trt-warn')).toBeNull();
  });

  it('says when the tracker matched titles only, and pages by 50', () => {
    const { f, el } = setUp({ items: [ROW], total: 120, fullText: false, page: 0, pageSize: 50 });
    expect(el.querySelector('.trt-warn')?.textContent).toContain('titles only');
    expect(el.textContent).toContain('page 1 of 3');
    const pages: number[] = [];
    f.componentInstance.page.subscribe((p) => pages.push(p));
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Next')) as HTMLButtonElement).click();
    expect(pages).toEqual([1]);
  });

  it('Add ▾ emits the picked action without opening the row', () => {
    const { f, el } = setUp({ items: [ROW], total: 1, fullText: true, page: 0, pageSize: 50 });
    const acts: RowAction[] = [];
    const opened: string[] = [];
    f.componentInstance.action.subscribe((a) => acts.push(a.action));
    f.componentInstance.opened.subscribe((r) => opened.push(r.id));
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Add ▾')) as HTMLButtonElement).click();
    f.detectChanges();
    (Array.from(el.querySelectorAll('[role=menuitem]')).find((b) => b.textContent?.includes('Link to card')) as HTMLButtonElement).click();
    expect(acts).toEqual(['LINK_CARD']);
    expect(opened).toEqual([]);
  });
});
