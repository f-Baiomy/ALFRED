import { NgTemplateOutlet } from '@angular/common';
import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ActivityEntry, CardDetail } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { BoardSeenService } from '../../../core/services/board-seen.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { RefTextComponent } from '../mention-chip/ref-text.component';
import { SelectPickerComponent } from '../../select-picker/select-picker.component';
import { CardDrawerComponent } from './card-drawer.component';

/** specs/023: the drawer's header, "Needs you", tabs and journey; the parts it embeds are tested on their own. */
function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: 'k1', project: 'p', number: 44, kind: 'TASK', title: 'Searching with one branch', status: 'DONE', resolution: null, reason: null, flags: [],
    scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: 'cy1', cycleDeleted: false, signature: null, createdAt: '2026-10-14T09:00:00Z',
    updatedAt: '2026-10-16T10:00:00Z', updatedBy: 'USER', teams: [], commentCount: 0, similarClosed: null, description: 'branchId is one value',
    links: [], ...over,
  } as CardDetail;
}

function entry(id: number, over: Partial<ActivityEntry>): ActivityEntry {
  return { id, cardId: 'k1', actor: 'USER', kind: 'COMMENT', text: 'hi', oldValue: null, newValue: null, at: '2026-10-15T09:00:00Z', replyTo: null, ...over };
}

describe('CardDrawerComponent (specs/023)', () => {
  let api: jasmine.SpyObj<BoardApiService>;

  function create(c: CardDetail, entries: ActivityEntry[] = [], seenAt: string | null = null) {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['card', 'activity', 'move', 'react', 'comment', 'update', 'reopen', 'teams']);
    api.teams.and.returnValue(of([]) as never);
    api.card.and.returnValue(of(c));
    api.activity.and.returnValue(of({ entries, total: entries.length }) as never);
    api.move.and.returnValue(of(c));
    TestBed.configureTestingModule({
      imports: [CardDrawerComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: BoardApiService, useValue: api },
        { provide: SessionCyclesApiService, useValue: { get: () => of({ id: 'cy1', name: 'Refund search' }) } },
        { provide: BoardSeenService, useValue: { seenAt: () => seenAt, markSeen: () => undefined, isUnread: () => false } },
        { provide: BoardMentionsService, useValue: { entryToShow: signal<number | null>(null), takePickedText: () => null, forget: () => undefined } }],
    }).overrideComponent(CardDrawerComponent, {
      set: { imports: [NgTemplateOutlet, MarkdownViewComponent, RefTextComponent, SelectPickerComponent], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    const fixture = TestBed.createComponent(CardDrawerComponent);
    fixture.componentRef.setInput('cardId', c.id);
    fixture.detectChanges(); // the effect loads the card
    fixture.detectChanges();
    return fixture;
  }

  const text = (f: { nativeElement: HTMLElement }, sel: string) => f.nativeElement.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('puts #N, the kind and the cycle by name in one bar', () => {
    const f = create(card());
    expect(text(f, '.cd-num')).toBe('#44');
    expect(text(f, '.cd-head > div:not([hidden]) > .cd-bar')).toContain('TASK');
    expect(text(f, '.cd-cycle')).toBe('◷ Refund search');
  });

  it('shows "Needs you" only for what waits on the user, with the notes folded inside it', () => {
    const quiet = create(card());
    expect(quiet.nativeElement.querySelector('.cd-needs')).toBeNull();
    TestBed.resetTestingModule();
    const f = create(card({ openQuestions: 2, reason: 'one value', similarClosed: { number: 31, resolution: 'FINE', reason: null } as never }));
    expect(text(f, '.cd-needs h5')).toBe('Needs you');
    expect(text(f, '.cd-needs')).toContain('2 open questions');
    expect(text(f, '.cd-notes-line')).toContain('2 notes');
  });

  it('the shrunk header opens in place with "Needs you", without scrolling the activity', () => {
    const f = create(card({ openQuestions: 2 }));
    const d = f.componentInstance;
    d.mini.set(true);
    f.detectChanges();
    expect(f.nativeElement.querySelector('.cd-head > div:not([hidden]) > .cd-bar .cd-mini-title')).not.toBeNull();
    expect(f.nativeElement.querySelector('.cd-peek-needs')).toBeNull();
    d.openPeek();
    f.detectChanges();
    expect(text(f, '.cd-head > div:not([hidden]) > .cd-bar')).toContain('TASK');
    expect(text(f, '.cd-peek-needs .cd-needs')).toContain('2 open questions');
    d.closePeek();
    f.detectChanges();
    expect(f.nativeElement.querySelector('.cd-peek-needs')).toBeNull();
  });

  it('a card with only notes shows them as a closed "Notes" line', () => {
    const f = create(card({ reason: 'one value' }));
    expect(text(f, '.cd-needs h5')).toBe('Notes');
    expect(f.nativeElement.querySelector('.cd-needs').classList).toContain('closed');
  });

  it('opens on Activity when there is a conversation, on Details when there is none', () => {
    const talk = create(card(), [entry(1, {})]);
    expect(text(talk, '.cd-tabs .on')).toContain('Activity');
    TestBed.resetTestingModule();
    const fresh = create(card(), []);
    expect(text(fresh, '.cd-tabs .on')).toContain('Details');
  });

  it('draws the journey from the status changes and moves the card from it', () => {
    const f = create(card({ status: 'FIXED' }), [entry(1, { kind: 'STATUS', newValue: 'TO_DO', at: '2026-10-14T10:00:00Z' }),
      entry(2, { kind: 'STATUS', newValue: 'FIXED', at: '2026-10-15T09:00:00Z' })]);
    const steps = [...f.nativeElement.querySelectorAll('.cd-j')] as HTMLButtonElement[];
    // In progress was skipped: no ✓ for it
    expect(steps.map((s) => s.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['✓ Inbox', '✓ To do', 'In progress', jasmine.stringMatching(/^● Fixed/) as never, 'Verified', 'Done']);
    steps[5].click();
    expect(api.move).toHaveBeenCalledWith('k1', 'DONE');
  });

  it('counts what is new since the user last looked', () => {
    const f = create(card(), [entry(1, { at: '2026-10-10T09:00:00Z' }), entry(2, { actor: 'CLAUDE', at: '2026-10-15T09:00:00Z' })], '2026-10-12T00:00:00Z');
    expect(f.componentInstance.newCount()).toBe(1);
    expect(f.nativeElement.querySelector('.cd-tabs .cd-dot')).not.toBeNull();
  });

  it('[ and ] step to the next card in the column; Shift+2 shows Details', () => {
    const f = create(card(), [entry(1, {})]);
    f.componentRef.setInput('siblings', { prev: 'k0', next: 'k2', index: 1, total: 3, column: 'Done' });
    f.detectChanges();
    const went: string[] = [];
    f.componentInstance.step.subscribe((id: string) => went.push(id));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true }));
    f.detectChanges();
    expect(went).toEqual(['k2']);
    expect(text(f, '.cd-tabs .on')).toContain('Details');
  });
});
