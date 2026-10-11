import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Team } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { TeamsSettingsComponent } from './teams-settings.component';

const TEAMS: Team[] = [
  { id: 'frontend', name: 'Frontend', color: '#5b8def', icon: '▣', owns: 'The web UI', hints: ['.ts:'], position: 0 },
  { id: 'backend', name: 'Backend', color: '#7ee3a0', icon: '⚙', owns: 'The Java services', hints: [], position: 1 },
];

describe('TeamsSettingsComponent', () => {
  function setUp() {
    const api = {
      teams: jasmine.createSpy('teams').and.returnValue(of(TEAMS)),
      createTeam: jasmine.createSpy('createTeam').and.returnValue(of(TEAMS[0])),
      reorderTeams: jasmine.createSpy('reorderTeams').and.returnValue(of([TEAMS[1], TEAMS[0]])),
    };
    TestBed.configureTestingModule({ imports: [TeamsSettingsComponent], providers: [{ provide: BoardApiService, useValue: api }] });
    const f = TestBed.createComponent(TeamsSettingsComponent);
    f.detectChanges();
    return { f, api, el: f.nativeElement as HTMLElement };
  }

  it('lists every team with what it owns and its hints', () => {
    const { el } = setUp();
    const rows = Array.from(el.querySelectorAll('.teams-table tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Frontend');
    expect(rows[0].textContent).toContain('The web UI');
    expect(rows[0].querySelector('code')?.textContent).toBe('.ts:');
  });

  it('adds a team with one hint per line, and reorders', () => {
    const { f, api, el } = setUp();
    f.componentInstance.add();
    f.componentInstance.patch({ name: ' Mobile ', owns: 'The apps', hints: 'ios\n\n android ' });
    f.componentInstance.save();
    expect(api.createTeam).toHaveBeenCalledWith({ name: 'Mobile', color: '#8b8b93', icon: '', owns: 'The apps', hints: ['ios', 'android'] });

    f.componentInstance.move(0, 1);
    expect(api.reorderTeams).toHaveBeenCalledWith(['backend', 'frontend']);
    f.detectChanges();
    expect(el.querySelector('.teams-table tbody tr')?.textContent).toContain('Backend');
  });
});
