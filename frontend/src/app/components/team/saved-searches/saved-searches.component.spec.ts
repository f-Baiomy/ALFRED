import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { SavedSearch, searchKey } from '../../../core/team/team.models';
import { TeamSavedSearchesComponent } from './saved-searches.component';

const BUGS: SavedSearch = { id: 1, conn: 'c1', name: 'My open bugs', query: { types: ['Bug'], assigned: ['me'], show: 'TREE' }, position: 0,
  lastCount: 7, updatedAt: null };
const SPRINT: SavedSearch = { id: 2, conn: 'c1', name: 'Sprint', query: { iterations: ['@current'] }, position: 1, lastCount: null, updatedAt: null };

describe('TeamSavedSearchesComponent (specs/029)', () => {
  function setUp(list: SavedSearch[] = [BUGS, SPRINT]) {
    const api = {
      savedSearches: jasmine.createSpy('savedSearches').and.returnValue(of(list)),
      createSaved: jasmine.createSpy('createSaved').and.callFake((_c: string, name: string, query: object) =>
        of({ id: 9, conn: 'c1', name, query, position: 2, lastCount: null, updatedAt: null })),
      updateSaved: jasmine.createSpy('updateSaved').and.callFake((id: number, b: object) => of({ ...BUGS, id, ...b })),
      moveSaved: jasmine.createSpy('moveSaved').and.returnValue(of([SPRINT, BUGS])),
      deleteSaved: jasmine.createSpy('deleteSaved').and.returnValue(of(undefined)),
    };
    TestBed.configureTestingModule({
      imports: [TeamSavedSearchesComponent],
      providers: [{ provide: TeamApiService, useValue: api }, { provide: TeamStateService, useValue: { savedVersion: signal(0) } }],
    });
    const f = TestBed.createComponent(TeamSavedSearchesComponent);
    f.componentRef.setInput('conn', 'c1');
    f.detectChanges();
    f.detectChanges();
    return { f, c: f.componentInstance, api, el: f.nativeElement as HTMLElement };
  }

  it('shows each saved search as a pill with its last count; a click runs it', () => {
    const { c, el } = setUp();
    const pills = Array.from(el.querySelectorAll('.tss-run')).map((b) => [b.childNodes[0].textContent?.trim(), b.querySelector('.tss-n')?.textContent ?? null]);
    expect(pills).toEqual([['My open bugs', '7'], ['Sprint', null]]);
    const ran: number[] = [];
    c.run.subscribe((s) => ran.push(s.id));
    (el.querySelector('.tss-run') as HTMLButtonElement).click();
    expect(ran).toEqual([1]);
  });

  it('saves the search on screen under a name', () => {
    const { f, c, api } = setUp();
    f.componentRef.setInput('current', { text: 'refund', show: 'PARENTS' });
    c.openSave();
    c.name = ' Refunds ';
    c.create();
    expect(api.createSaved).toHaveBeenCalledWith('c1', 'Refunds', { text: 'refund', show: 'PARENTS' });
    expect(c.list().map((s) => s.name)).toEqual(['My open bugs', 'Sprint', 'Refunds']);
    expect(c.saving()).toBeFalse();
  });

  it('a changed lit pill offers Save changes; move and delete go through the API', () => {
    const { f, c, api, el } = setUp();
    f.componentRef.setInput('lit', 1);
    f.componentRef.setInput('changed', true);
    f.componentRef.setInput('current', { types: ['Bug', 'Task'] });
    f.detectChanges();
    expect(el.textContent).toContain('You changed "My open bugs"');
    c.saveChanges(BUGS);
    expect(api.updateSaved).toHaveBeenCalledWith(1, { query: { types: ['Bug', 'Task'] } });
    c.move(SPRINT, -1);
    expect(c.list().map((s) => s.id)).toEqual([2, 1]);
    c.remove(SPRINT);
    expect(api.deleteSaved).toHaveBeenCalledWith(2);
  });

  it('no saved searches: no pill row', () => {
    const { el } = setUp([]);
    expect(el.querySelector('.tss')).toBeNull();
  });
});

describe('searchKey (specs/029)', () => {
  it('is the same for the same search in any order, and ignores page, Show and the saved id', () => {
    expect(searchKey({ types: ['Task', 'Bug'], page: 3, show: 'TREE', saved: 4 })).toBe(searchKey({ types: ['Bug', 'Task'] }));
    expect(searchKey({ assigned: 'me' } as never)).toBe(searchKey({ assigned: ['me'] }));
    expect(searchKey({ types: ['Bug'] })).not.toBe(searchKey({ types: ['Bug'], tagsAll: true }));
  });
});
