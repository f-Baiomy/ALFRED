import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { CardItem, CardMatch } from '../../../core/team/team.models';
import { TeamCardItemsComponent } from './card-items.component';

const LINKED: CardItem = { conn: 'c1', item: '61844', type: 'Bug', title: 'Date filter ignores TZ', state: 'Active', stateCategory: 'InProgress',
  changedBy: null, changedAt: null, copyRev: 3, changed: false, closedInAzure: false, comments: [], url: null };
const MATCH = (item: string, title: string, why: string | null): CardMatch => ({
  row: { boardId: 'b1', cardId: 'card-72', conn: 'c1', item, state: 'PROPOSED', why, score: 0.8, at: null }, type: 'Bug', title, state: 'New' });

describe('TeamCardItemsComponent - the card\'s Azure panel (specs/030)', () => {
  function setUp(items: CardItem[], matches: CardMatch[] = []) {
    const api = {
      cardItems: jasmine.createSpy('cardItems').and.returnValue(of(items)),
      bundles: jasmine.createSpy('bundles').and.returnValue(of([])),
      cardMatches: jasmine.createSpy('cardMatches').and.returnValue(of(matches)),
      linkMatch: jasmine.createSpy('linkMatch').and.returnValue(of([{ ...LINKED, item: '61902', title: '251st agency accepted' }])),
      rejectMatch: jasmine.createSpy('rejectMatch').and.returnValue(of(matches.slice(1))),
      direct: jasmine.createSpy('direct').and.returnValue(of({ id: 5, state: 'DONE' })),
    };
    const chat = { post: jasmine.createSpy('post').and.returnValue(of({ id: 1 })) };
    const state = {
      loaded: () => true, load: () => undefined, connections: () => [{ id: 'c1' }], picked: () => ({ id: 'c1' }),
      ui: () => ({ label: 'Azure', word: (w: string) => w }), boardEvent: signal(null),
      lists: () => ({ types: ['Bug', 'Task'], areas: [], iterations: [], states: [
        { project: 'P', type: 'Bug', name: 'Active', category: 'InProgress' }, { project: 'P', type: 'Bug', name: 'Resolved', category: 'Resolved' },
        { project: 'P', type: 'Task', name: 'Closed', category: 'Completed' }] }),
    };
    TestBed.configureTestingModule({
      imports: [TeamCardItemsComponent],
      providers: [{ provide: TeamApiService, useValue: api }, { provide: ChatApiService, useValue: chat }, { provide: TeamStateService, useValue: state }],
    });
    const f = TestBed.createComponent(TeamCardItemsComponent);
    f.componentRef.setInput('cardId', 'card-72');
    f.componentRef.setInput('cardNumber', 72);
    f.componentRef.setInput('boardId', 'b1');
    f.componentRef.setInput('project', 'odeysys');
    f.detectChanges();
    f.detectChanges();
    return { f, api, chat, el: f.nativeElement as HTMLElement };
  }
  const button = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes(text)) as HTMLButtonElement;

  it('a card with no item shows the best match with its reason; Show others shows the rest', () => {
    const { f, el } = setUp([], [MATCH('61902', '251st agency accepted', 'Same endpoint (POST /refunds/search), same repro'), MATCH('61910', 'Agency list slow', null)]);
    expect(el.textContent).toContain('Looks like an item in Azure');
    expect(el.textContent).toContain('251st agency accepted');
    expect(el.textContent).toContain('Same endpoint (POST /refunds/search), same repro');
    expect(el.textContent).not.toContain('Agency list slow');
    button(el, 'Show others (1)').click();
    f.detectChanges();
    expect(el.textContent).toContain('Agency list slow');
  });

  it('Link links the card to the item with no bundle; Not this one drops it for good', () => {
    const { f, api, el } = setUp([], [MATCH('61902', '251st agency accepted', null), MATCH('61910', 'Agency list slow', null)]);
    button(el, 'Not this one').click();
    f.detectChanges();
    expect(api.rejectMatch).toHaveBeenCalledWith('card-72', 'c1', '61902');
    expect(el.textContent).toContain('will not be proposed for this card again');
    button(el, 'Link').click();
    f.detectChanges();
    expect(api.linkMatch).toHaveBeenCalledWith('card-72', 'c1', '61910');
    expect(el.textContent).toContain('Nothing was written to Azure');
    expect(el.querySelector('.tci-item')!.textContent).toContain('251st agency accepted');
  });

  it('a linked card opens Azure ▾: the user\'s own comment and state go at once; Draft with Claude asks the board chat', () => {
    const { f, api, chat, el } = setUp([LINKED]);
    expect(api.cardMatches).not.toHaveBeenCalled();
    button(el, 'Azure ▾').click();
    f.detectChanges();
    const options = Array.from(el.querySelectorAll('.tci-panel select option')).map((o) => o.textContent!.trim());
    expect(options).toEqual(['Active', 'Resolved']);

    f.componentInstance.comment = 'Fixed in 4be21c';
    f.componentInstance.sendComment(LINKED);
    expect(api.direct).toHaveBeenCalledWith('c1', '61844', { comment: 'Fixed in 4be21c', card: 'card-72', board: 'b1' });
    f.componentInstance.newState = 'Resolved';
    f.componentInstance.sendState(LINKED);
    expect(api.direct).toHaveBeenCalledWith('c1', '61844', { state: 'Resolved', card: 'card-72', board: 'b1' });

    f.componentInstance.togglePanel(LINKED);
    f.detectChanges();
    f.componentInstance.draftWithClaude();
    f.detectChanges();
    expect(chat.post).toHaveBeenCalledWith('odeysys', 'b1', { text: '/alfred-team update card #72' });
    expect(el.textContent).toContain('the draft comes back here as a bundle to approve');
  });
});
