import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { BoardStage } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { SyncResult } from '../../../core/team/team.models';
import { StageStripComponent, refreshLine } from './stage-strip.component';

const COUNTS = { brief: false, items: 0, inbox: 0, waitingOnUser: 0, toDo: 0, inProgress: 0, fixed: 0, untested: 0, failing: 0, unmarked: 0 };
const DEFINE: BoardStage = { stage: 'DEFINE', ref: 'AB#61813', counts: COUNTS,
  next: '/alfred-setup AB#61813 - Claude reads the task (and its work item) and drafts the brief, spec, test steps and cards' };
const TRIAGE: BoardStage = { stage: 'TRIAGE', ref: 'AB#61813', counts: { ...COUNTS, brief: true, items: 3, inbox: 2 },
  next: '/alfred-triage AB#61813 - sort the 2 Inbox card(s): yours, another team\'s, or close' };

describe('StageStripComponent (specs/030)', () => {
  function setUp(stage: BoardStage, opts: { runner?: boolean; terminal?: boolean; linked?: string | null } = {}) {
    const boards = {
      stage: jasmine.createSpy('stage').and.returnValue(of(stage)),
      liveRunner: jasmine.createSpy('liveRunner').and.returnValue(of(opts.runner ? { project: 'odeysys', host: 'pc', kind: 'live' } : null)),
    };
    const chat = {
      summaries: jasmine.createSpy('summaries').and.returnValue(of(opts.terminal ? [{ scope: 'b1', terminal: { open: true }, claudeOn: false }] : [])),
      post: jasmine.createSpy('post').and.returnValue(of({ id: 1 })),
    };
    const team = { refresh: jasmine.createSpy('refresh') };
    TestBed.configureTestingModule({
      imports: [StageStripComponent],
      providers: [
        { provide: BoardApiService, useValue: boards },
        { provide: ChatApiService, useValue: chat },
        { provide: TeamApiService, useValue: team },
        { provide: BoardSocketService, useValue: { events$: new Subject() } },
      ],
    });
    const f = TestBed.createComponent(StageStripComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('linkedItem', opts.linked === undefined ? 'c1/61813' : opts.linked);
    f.detectChanges();
    f.detectChanges(); // the effect read the stage during the first pass
    return { f, boards, chat, team, el: f.nativeElement as HTMLElement };
  }

  it('shows the seven stages with the current one marked and its command to copy', () => {
    const { el } = setUp(TRIAGE);
    const stages = Array.from(el.querySelectorAll('.bs')).map((s) => s.textContent!.trim());
    expect(stages).toEqual(['1 Board', '2 Define', '3 Triage', '4 Code', '5 Verify', '6 Test', '7 Close']);
    expect(el.querySelector('.bs.on')!.textContent).toContain('Triage');
    expect(el.querySelectorAll('.bs.done').length).toBe(2);
    expect(el.querySelector('.ss-next')!.textContent).toContain('/alfred-triage AB#61813');
    expect(el.textContent).not.toContain('Not defined yet');
  });

  it('a board with no brief says "Not defined yet"; Ask Claude in chat waits for someone to answer the board', () => {
    const idle = setUp(DEFINE);
    expect(idle.el.textContent).toContain('Not defined yet');
    expect(idle.el.textContent).toContain('/alfred-setup AB#61813');
    const ask = Array.from(idle.el.querySelectorAll('button')).find((b) => b.textContent!.includes('Ask Claude in chat')) as HTMLButtonElement;
    expect(ask.disabled).toBeTrue();
    expect(ask.title).toContain('Start /alfred-live AB#61813 first');
    expect(idle.chat.post).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const live = setUp(DEFINE, { terminal: true });
    const btn = Array.from(live.el.querySelectorAll('button')).find((b) => b.textContent!.includes('Ask Claude in chat')) as HTMLButtonElement;
    expect(btn.disabled).toBeFalse();
    btn.click();
    live.f.detectChanges();
    expect(live.chat.post).toHaveBeenCalledWith('odeysys', 'b1', { text: '/alfred-setup AB#61813' });
    expect(live.el.textContent).toContain('Sent to the board chat');
  });

  it('Refresh from Azure shows only for a board with a main item and reports what changed, with a banner when the main moved', () => {
    expect(setUp(TRIAGE, { linked: null }).el.textContent).not.toContain('Refresh from Azure');
    TestBed.resetTestingModule();

    const { f, team, el } = setUp(TRIAGE);
    const result: SyncResult = { boardId: 'b1', checked: 4, changed: 1, newInTree: 1, leftTree: 0, skipped: false,
      newItems: [{ conn: 'c1', item: '61902', type: 'Bug', title: '251st agency accepted', state: 'New' }],
      changedItems: [{ conn: 'c1', item: '61813', title: 'Filters', fields: ['System.State', 'comments'], newComments: 2 }],
      mainState: { conn: 'c1', item: '61813', fromState: 'Active', toState: 'Removed', category: 'Removed', closed: true, fromIteration: 'S1', toIteration: 'S1' },
      matches: 1 };
    team.refresh.and.returnValue(of(result));
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes('Refresh from Azure')) as HTMLButtonElement).click();
    f.detectChanges();
    expect(team.refresh).toHaveBeenCalledWith('b1');
    expect(el.textContent).toContain('Azure: 1 changed · 2 new comments · 1 new in the tree (in Incoming) · 1 possible card match');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('moved Active → Removed');
    expect(el.textContent).toContain('proposes closing the open cards as Not in this flow');
  });

  it('a refresh with no token says to enter it in the Team tab', () => {
    const { f, team, el } = setUp(TRIAGE);
    team.refresh.and.returnValue(throwError(() => ({ error: { error: 'TOKEN_MISSING', message: 'x' } })));
    f.componentInstance.refresh();
    f.detectChanges();
    expect(el.textContent).toContain('Enter your token in the Team tab first');
  });

  it('refreshLine says "No changes" when nothing moved', () => {
    expect(refreshLine({ boardId: 'b', checked: 3, changed: 0, newInTree: 0, leftTree: 0, skipped: false, changedItems: [], newItems: [], matches: 0 }))
      .toBe('No changes in Azure');
  });
});
