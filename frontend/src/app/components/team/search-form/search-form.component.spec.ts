import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamLists, TeamSearch } from '../../../core/team/team.models';
import { ME, TeamSearchFormComponent } from './search-form.component';

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

  it('sends "me" for assigned, a team as Project\\Team, and tags split on commas', () => {
    const { c, got } = setUp();
    c.assigned = ME;
    c.team = c.teamValue(LISTS.teams[0]);
    c.tags = 'ui, payments ,';
    c.run();
    expect(got[0].assigned).toBe('me');
    expect(got[0].teams).toEqual(['Shop\\Payments']);
    expect(got[0].tags).toEqual(['ui', 'payments']);
    expect(c.count()).toBe(3);
  });

  it('a preset fills the form and runs it', () => {
    const { f, c, got } = setUp();
    f.componentRef.setInput('preset', { iterations: ['Shop\\Sprint 4'], openOnly: true });
    f.detectChanges();
    expect(c.iteration).toBe('Shop\\Sprint 4');
    expect(got.at(-1)?.iterations).toEqual(['Shop\\Sprint 4']);
    expect(c.more()).toBeTrue();
  });

  it('Clear keeps the text and drops every filter', () => {
    const { c, got } = setUp();
    c.text = 'refund';
    c.types = ['Bug'];
    c.clear();
    expect(got.at(-1)?.text).toBe('refund');
    expect(got.at(-1)?.types).toEqual([]);
  });
});
