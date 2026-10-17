import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SearchResult, SearchRow } from '../../../core/team/team.models';
import { RowAction, TeamResultsTableComponent, treeLines } from './results-table.component';

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

  it('while Azure is read, skeleton rows stand in for the results (specs/029)', () => {
    const { f, el } = setUp({ items: [ROW], total: 1, fullText: true, page: 0, pageSize: 50 });
    f.componentRef.setInput('loading', true);
    f.detectChanges();
    expect(el.querySelectorAll('tr.trt-sk').length).toBe(8);
    expect(el.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(el.textContent).not.toContain('Refund fails');
    f.componentRef.setInput('loading', false);
    f.detectChanges();
    expect(el.querySelectorAll('tr.trt-sk').length).toBe(0);
    expect(el.textContent).toContain('Refund fails');
  });

  describe('tree (specs/029)', () => {
    const r = (id: string, parent: string | null, title = 'Item ' + id): SearchRow => ({ ...ROW, id, parent, title, boards: [] });
    // matches 62123 and 59851; 61800/61000 are parents, 61814 a child of 61813 (a match too)
    const TREE: SearchResult = {
      items: [r('59851', null), r('62123', '61800'), r('61813', '61800')], total: 3, fullText: true, page: 0, pageSize: 50, show: 'TREE',
      context: [r('61800', '61000'), r('61000', null), r('61814', '61813')], contextLeftOut: 0,
    };

    it('puts each match under its parents, context marked, in the search order', () => {
      const lines = treeLines(TREE, new Set());
      expect(lines.map((l) => `${'-'.repeat(l.depth)}${l.row.id}:${l.role ?? 'match'}`)).toEqual([
        '59851:match', '61000:parent', '-61800:parent', '--62123:match', '--61813:match', '---61814:child',
      ]);
    });

    it('folding a row hides its subtree; items only is the flat page', () => {
      expect(treeLines(TREE, new Set(['61800'])).map((l) => l.row.id)).toEqual(['59851', '61000', '61800']);
      expect(treeLines({ ...TREE, show: 'ITEMS', context: [] }, new Set()).map((l) => l.row.id)).toEqual(['59851', '62123', '61813']);
    });

    it('renders the Show switch and emits a new choice', () => {
      const { f, el } = setUp(TREE);
      expect(el.textContent).toContain('+3 parents and children for context');
      expect(el.querySelectorAll('tr.ctx').length).toBe(3);
      const shows: string[] = [];
      f.componentInstance.showChange.subscribe((s) => shows.push(s));
      (Array.from(el.querySelectorAll('[role=radio]')).find((b) => b.textContent?.includes('Items only')) as HTMLButtonElement).click();
      expect(shows).toEqual(['ITEMS']);
    });
  });
});
