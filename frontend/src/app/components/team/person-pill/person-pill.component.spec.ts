import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamMe, TeamPerson } from '../../../core/team/team.models';
import { PersonPillComponent } from './person-pill.component';

const SARA: TeamPerson = { extId: 'p1', name: 'Sara Ali', email: 'sara@x' };

describe('PersonPillComponent (specs/028 FR-085)', () => {
  function setUp(inputs: Record<string, unknown>, me: TeamMe | null = null) {
    const api = { person: jasmine.createSpy('person').and.returnValue(of({ person: SARA, me: false, teams: [{ id: 't', name: 'Payments', project: 'Shop' }],
      assignedOpen: 3, cardsOwned: [], cardsMentioning: [], boards: [] })) };
    TestBed.configureTestingModule({
      imports: [PersonPillComponent],
      providers: [
        { provide: TeamApiService, useValue: api },
        { provide: TeamStateService, useValue: { me: signal(me), picked: () => ({ id: 'c1' }), personOf: (id: string | null) => (id === 'sara@x' ? SARA : null) } },
      ],
    });
    const f = TestBed.createComponent(PersonPillComponent);
    for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
    f.detectChanges();
    return { f, api, el: f.nativeElement as HTMLElement };
  }

  it('shows the name and initials, never the raw id when the lists know the person', () => {
    const { el } = setUp({ personId: 'sara@x' });
    expect(el.textContent).toContain('Sara Ali');
    expect(el.querySelector('.pp-av')?.textContent).toBe('SA');
    expect(el.textContent).not.toContain('sara@x ');
  });

  it('marks "me"', () => {
    const { el } = setUp({ person: SARA }, { person: SARA, source: 'TOKEN_OWNER' });
    expect(el.querySelector('.pp-me')?.textContent).toBe('me');
  });

  it('reads the hover card once, on first hover', () => {
    const { f, api, el } = setUp({ person: SARA, conn: 'c1' });
    const pill = el.querySelector('.pp') as HTMLElement;
    pill.dispatchEvent(new Event('mouseenter'));
    pill.dispatchEvent(new Event('mouseenter'));
    f.detectChanges();
    expect(api.person).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.pp-card')?.textContent).toContain('3 open items assigned');
    expect(el.querySelector('.pp-card')?.textContent).toContain('Payments');
  });

  it('a missing person is a dash', () => {
    const { el } = setUp({});
    expect(el.textContent?.trim()).toBe('Unassigned');
  });
});
