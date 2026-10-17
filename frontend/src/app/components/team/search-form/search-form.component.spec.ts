import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamLists, TeamSearch } from '../../../core/team/team.models';
import { ME, NONE, TeamSearchFormComponent } from './search-form.component';

const LISTS: TeamLists = {
  types: ['Bug', 'Task'], states: [{ project: 'Shop', type: 'Bug', name: 'Active', category: 'InProgress' }], areas: ['Shop\\Pay'],
  teams: [{ conn: 'c1', extId: 't1', name: 'Payments', project: 'Shop', alfredProject: null, alfredTeam: null, members: [] }],
  iterations: [], people: [{ extId: 'p1', name: 'Sara', email: 'sara@x' }], boards: [], at: null,
};

describe('TeamSearchFormComponent (specs/028 US1)', () => {
  function setUp() {
    TestBed.configureTestingModule({
      imports: [TeamSearchFormComponent],
      providers: [{ provide: TeamStateService, useValue: { lists: signal(LISTS), ui: () => ({ word: (w: string) => w }) } }],
    });
    const f = TestBed.createComponent(TeamSearchFormComponent);
    const got: TeamSearch[] = [];
    f.componentInstance.search.subscribe((s) => got.push(s));
    f.detectChanges();
    return { f, c: f.componentInstance, got };
  }

  it('searches with Open only on by default and the text trimmed', () => {
    const { c, got } = setUp();
    c.text = '  refund ';
    c.run();
    expect(got[0].openOnly).toBeTrue();
    expect(got[0].text).toBe('refund');
    expect(got[0].page).toBe(0);
  });

  it('every filter takes several values; me and Unassigned are values of Assigned', () => {
    const { c, got } = setUp();
    c.set('assigned', [ME, NONE, 'sara@x']);
    c.set('teams', [c.teamValue(LISTS.teams[0])]);
    c.set('tags', ['ui', 'payments']);
    c.set('parents', ['#59415', '61200']);
    c.tagsAll.set(true);
    c.areaExact.set(true);
    c.run();
    expect(got[0].assigned).toEqual(['me', 'none', 'sara@x']);
    expect(got[0].teams).toEqual(['Shop\\Payments']);
    expect(got[0].tags).toEqual(['ui', 'payments']);
    expect(got[0].parents).toEqual(['59415', '61200']);
    expect(got[0].tagsAll).toBeTrue();
    expect(got[0].areaExact).toBeTrue();
    expect(c.count()).toBe(4);
    const chips = c.chips();
    expect(chips.find((x) => x.key === 'assigned')?.values).toEqual(['me', 'Unassigned', 'Sara']);
    expect(chips.find((x) => x.key === 'tags')?.join).toBe('and');
  });

  it('a chip removes its whole filter and searches again', () => {
    const { c, got } = setUp();
    c.set('types', ['Bug', 'Task']);
    c.drop('types');
    expect(got.at(-1)?.types).toEqual([]);
    expect(c.chips().length).toBe(0);
  });

  it('an older saved search (one person, parent) fills as lists', () => {
    const { f, c } = setUp();
    f.componentRef.setInput('preset', { assigned: 'me', parent: '7', openOnly: true } as unknown as TeamSearch);
    f.detectChanges();
    expect(c.v().assigned).toEqual(['me']);
    expect(c.v().parents).toEqual(['7']);
  });

  it('a preset fills the form and runs it', () => {
    const { f, c, got } = setUp();
    f.componentRef.setInput('preset', { iterations: ['Shop\\Sprint 4'], openOnly: true });
    f.detectChanges();
    expect(c.v().iterations).toEqual(['Shop\\Sprint 4']);
    expect(got.at(-1)?.iterations).toEqual(['Shop\\Sprint 4']);
    expect(c.more()).toBeTrue();
  });

  it('Clear keeps the text and drops every filter', () => {
    const { c, got } = setUp();
    c.text = 'refund';
    c.set('types', ['Bug']);
    c.clear();
    expect(got.at(-1)?.text).toBe('refund');
    expect(got.at(-1)?.types).toEqual([]);
  });
});
