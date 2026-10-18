import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { BoardStage } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { BoardBannerService } from '../../../core/state/board-banner.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { BoardFactsComponent, stageCount } from './board-facts.component';

const COUNTS = { brief: true, items: 4, inbox: 0, waitingOnUser: 1, toDo: 0, inProgress: 0, fixed: 2, untested: 0, failing: 0, unmarked: 0 };
const VERIFY: BoardStage = { stage: 'VERIFY', ref: 'AB#59851', next: 'x', counts: COUNTS };
const MAIN = { conn: 'c1', item: '59851', provider: 'Azure DevOps', snapshot: { type: 'Thread', state: 'Ready for UAT', url: 'https://dev.azure.com/x/59851' }, changes: [] };

describe('BoardFactsComponent (specs/032 T043)', () => {
  let team: { mainOf: jasmine.Spy; refresh: jasmine.Spy; fetchAttachments: jasmine.Spy };
  let hasToken: ReturnType<typeof signal<boolean>>;

  function render(main: unknown) {
    team = { mainOf: jasmine.createSpy('mainOf').and.returnValue(of(main)),
      refresh: jasmine.createSpy('refresh').and.returnValue(of({ changed: 1, newInTree: 0, leftTree: 0, matches: 0 })),
      fetchAttachments: jasmine.createSpy('fetch').and.returnValue(of({ attached: ['a.png'], notAttached: [] })) };
    hasToken = signal(false);
    TestBed.configureTestingModule({
      imports: [BoardFactsComponent],
      providers: [
        { provide: TeamApiService, useValue: team },
        { provide: TeamStateService, useValue: { loaded: () => true, load: () => undefined, startVersion: () => 0, boardEvent: () => null, hasToken, readToken: () => undefined } },
        { provide: BoardApiService, useValue: { nextSteps: () => of({ waitingOnUser: [{ number: 74 }], waitingOnClaude: 0, toDo: 0, inProgress: 0, fixed: 2, inbox: 0 }) } },
        { provide: BoardSocketService, useValue: { events$: new Subject() } },
        { provide: BoardMentionsService, useValue: { cardToOpen: signal(null) } },
      ],
    });
    const f = TestBed.createComponent(BoardFactsComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('stage', VERIFY);
    f.componentRef.setInput('cards', 4);
    f.detectChanges();
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  it('says the work item, the cards, what waits on you and the stage\'s count, with Azure ▾', () => {
    const { f, el } = render(MAIN);
    const text = el.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Work item Thread · Ready for UAT');
    expect(text).toContain('4 cards');
    expect(text).toContain('⚑ 1 waits on you');
    expect(el.querySelector('.amber')!.textContent).toBe('2 Fixed waiting');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Azure ▾')) as HTMLButtonElement).click();
    f.detectChanges();
    expect(Array.from(el.querySelectorAll('.mi')).map((m) => m.firstChild?.textContent?.trim()))
      .toEqual(['↻ Refresh from Azure', '⇩ Fetch attachments', '↗ Open AB#59851 in Azure']);
  });

  it('opens the first waiting card', () => {
    const { el } = render(MAIN);
    (el.querySelector('.you') as HTMLButtonElement).click();
    expect(TestBed.inject(BoardMentionsService).cardToOpen()).toEqual({ project: 'odeysys', number: 74 });
  });

  it('puts what a refresh found in the banner, and asks for a token before fetching', () => {
    const { f, el } = render(MAIN);
    const banner = TestBed.inject(BoardBannerService);
    f.componentInstance.refresh();
    expect(banner.current()!.text).toBe('Azure: 1 changed');
    f.componentInstance.fetch();
    expect(banner.current()!.text).toBe('Enter a token on the Team tab');
    expect(team.fetchAttachments).not.toHaveBeenCalled();
    hasToken.set(true);
    f.componentInstance.fetch();
    expect(banner.current()!.text).toBe('1 attachment fetched');
    void el;
  });

  it('a board without a main item has no work item part and no Azure ▾', () => {
    const { el } = render(null);
    expect(el.textContent).not.toContain('Work item');
    expect(el.textContent).not.toContain('Azure');
    expect(el.textContent).toContain('4 cards');
  });

  it('words each stage\'s count', () => {
    expect(stageCount({ ...VERIFY, stage: 'CODE', counts: { ...COUNTS, toDo: 2 } })).toBe('2 To do');
    expect(stageCount({ ...VERIFY, stage: 'TRIAGE', counts: { ...COUNTS, inbox: 3 } })).toBe('3 in the Inbox');
    expect(stageCount({ ...VERIFY, stage: 'DEFINE' })).toBeNull();
  });
});
