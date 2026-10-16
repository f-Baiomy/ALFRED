import { Component, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivityEntry } from '../../../core/models/board.models';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { ActivityTimelineComponent, TimelineReply } from './activity-timeline.component';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';

/** The real editor is tested on its own; here it is what the timeline does with what it submits. */
@Component({ selector: 'app-mention-editor', standalone: true, template: '<span class="fake-editor">{{ submitLabel() }}</span>' })
class FakeEditorComponent {
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly card = input<unknown>(null);
  readonly attach = input<unknown>(null);
  readonly rows = input(3);
  readonly cancellable = input(false);
  readonly submitLabel = input('Comment');
  readonly placeholder = input('');
  readonly draftKey = input<string | null>(null);
  readonly value = input('');
  readonly enterSends = input(true);
  readonly compact = input(false);
  readonly submitted = output<string>();
  readonly cancelled = output<void>();
}

function e(id: number, actor: ActivityEntry['actor'], text: string, replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-10T09:00:00Z', replyTo };
}

describe('ActivityTimelineComponent', () => {
  function create(entries: ActivityEntry[], editable = true) {
    TestBed.configureTestingModule({ imports: [ActivityTimelineComponent], providers: [{ provide: BoardMentionsService, useValue: { entryToShow: signal<number | null>(null) } }] })
      .overrideComponent(ActivityTimelineComponent, { remove: { imports: [MentionEditorComponent] }, add: { imports: [FakeEditorComponent] } });
    const fixture = TestBed.createComponent(ActivityTimelineComponent);
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
    return fixture;
  }

  function buttons(fixture: ReturnType<typeof create>): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('.cd-thread-foot button')];
  }

  it('gives a comment\'s snippets the same context object on every check (a new one each time froze the page)', () => {
    const fixture = create([e(1, 'CLAUDE', '**Reply** chart:\n\n```html live\n<b>hi</b>\n```')]);
    const card = { id: 'k', number: 39, project: 'p', cycleId: 'c', title: 't' };
    fixture.componentRef.setInput('card', card);
    fixture.detectChanges();
    const t = fixture.componentInstance;
    const first = t.snippetContext(1);
    expect(t.snippetContext(1)).toBe(first);
    expect(first).toEqual({ card: 39, cardId: 'k', project: 'p', cycleId: 'c', comment: 1 });
    expect(() => fixture.detectChanges()).not.toThrow();
    fixture.detectChanges();
    expect(t.snippetContext(1)).toBe(first);
    fixture.componentRef.setInput('card', { ...card, number: 40 });
    expect(t.snippetContext(1)['card']).toBe(40);
  });

  it('shows replies under their comment (folded until opened), and an open question with Answer', () => {
    const fixture = create([e(1, 'USER', 'why?'), e(2, 'CLAUDE', '**Reply** because', 1), e(3, 'CLAUDE', '**Question** which?')]);
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(0);
    const fold = fixture.nativeElement.querySelector('.cd-fold') as HTMLButtonElement;
    expect(fold.textContent).toContain('▸ 1 reply');
    fold.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.cd-fold').textContent).toContain('▾ 1 reply');
    expect(fixture.nativeElement.querySelector('.board-ev-badge').textContent).toContain('waiting for you');
    expect(buttons(fixture).map((b) => b.textContent!.trim())).toContain('↩ Answer in your own words…');
    expect(buttons(fixture).map((b) => b.textContent!.trim())).toContain('Reply…');
  });

  it('an answer carries the question it answers and clears Needs decision by default', () => {
    const fixture = create([e(3, 'CLAUDE', '**Question** which?')]);
    const sent: TimelineReply[] = [];
    fixture.componentInstance.replied.subscribe((r) => sent.push(r));
    buttons(fixture).find((b) => b.textContent!.includes('Answer'))!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fake-editor').textContent).toBe('Answer');
    expect(fixture.nativeElement.querySelector('.board-ev-clear input').checked).toBeTrue();

    fixture.componentInstance.send(fixture.componentInstance.items()[0], 'this one');
    expect(sent).toEqual([{ text: 'this one', replyTo: 3, clearDecision: true }]);
  });

  it('a reply to a plain comment never clears anything, and an answered question says so', () => {
    const fixture = create([e(1, 'USER', 'note'), e(3, 'CLAUDE', '**Question** which?'), e(4, 'USER', 'that', 3)]);
    const sent: TimelineReply[] = [];
    fixture.componentInstance.replied.subscribe((r) => sent.push(r));
    fixture.componentInstance.send(fixture.componentInstance.items()[0], 'ok');
    expect(sent[0]).toEqual({ text: 'ok', replyTo: 1, clearDecision: false });
    expect(fixture.nativeElement.querySelector('.board-ev-badge').textContent).toContain('answered');
  });

  it('a viewer who may not edit sees the threads but no Reply', () => {
    const fixture = create([e(1, 'USER', 'note'), e(2, 'CLAUDE', '**Reply** ok', 1)], false);
    // Claude's latest answer in the newest thread shows as the card opens
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(1);
    expect(buttons(fixture).filter((b) => /Reply|Answer|Edit|☺/.test(b.textContent ?? '')).length).toBe(0); // ⧉ Copy stays: reading
  });
  // ------------------------------------------------------------------------------------------- specs/023 layout
  function at(id: number, actor: ActivityEntry['actor'], text: string, when: string, replyTo: number | null = null): ActivityEntry {
    return { ...e(id, actor, text, replyTo), at: when };
  }

  it('shows the last five threads whole and the older history behind one "Show N earlier" line - never an open question', () => {
    const t = (id: number, day: number, text: string) => at(id, 'USER', text, `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`);
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => t(n, n + 1, `thread ${n}`));
    const fixture = create(many);
    const earlier = () => fixture.nativeElement.querySelector('.cd-earlier') as HTMLButtonElement | null;
    expect(fixture.nativeElement.querySelectorAll('.cd-thread').length).toBe(5);
    expect(earlier()!.textContent).toContain('Show 3 earlier threads');
    earlier()!.click();
    fixture.detectChanges();
    expect(earlier()).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.cd-thread').length).toBe(8);

    TestBed.resetTestingModule();
    const withQuestion = create([at(20, 'CLAUDE', '**Question** still open?', '2026-10-01T09:00:00Z'), ...many]);
    expect(withQuestion.nativeElement.querySelector('.cd-earlier')).toBeNull();
    expect(withQuestion.nativeElement.querySelectorAll('.cd-thread').length).toBe(9);
  });

  it('brings a long history in a page at a time, never all at once', () => {
    const many = Array.from({ length: 30 }, (_, n) => at(n + 1, 'USER', `thread ${n + 1}`, `2026-10-01T${String(n % 24).padStart(2, '0')}:00:00Z`));
    const fixture = create(many);
    const earlier = () => fixture.nativeElement.querySelector('.cd-earlier') as HTMLButtonElement | null;
    earlier()!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-thread').length).toBe(20);
    expect(earlier()!.textContent).toContain('Show 10 earlier threads');
  });

  it('marks what is new since the user looked and shows it - a new reply is never folded away', () => {
    TestBed.configureTestingModule({ imports: [ActivityTimelineComponent], providers: [{ provide: BoardMentionsService, useValue: { entryToShow: signal<number | null>(null) } }] })
      .overrideComponent(ActivityTimelineComponent, { remove: { imports: [MentionEditorComponent] }, add: { imports: [FakeEditorComponent] } });
    const fixture = TestBed.createComponent(ActivityTimelineComponent);
    // the drawer gives the card's "seen at" with its entries: the branch holding the new answer opens by itself
    fixture.componentRef.setInput('newSince', '2026-10-04T00:00:00Z');
    fixture.componentRef.setInput('entries', [
      at(1, 'USER', 'old', '2026-10-01T09:00:00Z'), at(2, 'CLAUDE', '**Reply** new answer', '2026-10-05T09:00:00Z', 1),
      at(3, 'USER', 'x', '2026-10-06T09:00:00Z'), at(4, 'USER', 'y', '2026-10-07T09:00:00Z'),
    ]);
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cd-fold').textContent).toContain('▾');
    const fresh = fixture.nativeElement.querySelectorAll('[data-new]');
    expect(fresh.length).toBe(1);
    expect(fresh[0].textContent).toContain('new answer');
  });

  it('draws replies as a tree: each level opens on its own, ↩ answers that reply, ⊞ opens all and ⊟ folds all', () => {
    const r = (id: number, text: string, answers: number | null) => ({ ...at(id, id % 2 ? 'USER' : 'CLAUDE', text, `2026-10-01T09:0${id}:00Z`, 1), answers });
    // 2 and 5 answer the first comment; 3 answers 2; 4 answers 3
    const fixture = create([at(1, 'USER', 'root', '2026-10-01T09:00:00Z'), r(2, 'two', null), r(3, 'three', 2), r(4, 'four', 3), r(5, 'five', null)]);
    const t = fixture.componentInstance;
    const shown = () => [...fixture.nativeElement.querySelectorAll('.cd-kid')].map((k) => Number((k as HTMLElement).querySelector('[data-entry]')!.getAttribute('data-entry')));
    const folds = () => [...fixture.nativeElement.querySelectorAll('.cd-fold')].map((f) => (f as HTMLElement).textContent!.replace(/\s+/g, ' ').trim());
    expect(folds()).toEqual(['▸ 4 replies']);
    (fixture.nativeElement.querySelector('.cd-fold') as HTMLButtonElement).click();
    fixture.detectChanges();
    // level 1 open: 2 and 5; 2 keeps its two below it folded
    expect(shown()).toEqual([2, 5]);
    expect(folds()).toEqual(['▾ 4 replies', '▸ 2 replies']);
    // one step right per level: a reply sits inside the replies of what it answers
    t.toggleReplies(2);
    fixture.detectChanges();
    expect(shown()).toEqual([2, 3, 5]);
    const three = fixture.nativeElement.querySelector('[data-entry="3"]') as HTMLElement;
    expect(three.closest('.cd-kids')!.parentElement!.closest('.cd-kid')!.querySelector('[data-entry]')!.getAttribute('data-entry')).toBe('2');

    const sent: TimelineReply[] = [];
    t.replied.subscribe((x) => sent.push(x));
    t.startReply(t.items()[0], t.entries().find((x) => x.id === 3));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.board-ev-replyto').textContent).toContain('three');
    t.send(t.items()[0], 'ok', 3);
    expect(sent).toEqual([{ text: 'ok', replyTo: 3, clearDecision: false }]);
    fixture.detectChanges();
    // the reply lands under 3: it stays open to show it
    expect(t.repliesOpen(3)).toBeTrue();

    t.foldAll();
    fixture.detectChanges();
    expect(shown()).toEqual([]);
    t.openAll();
    fixture.detectChanges();
    expect(shown()).toEqual([2, 3, 4, 5]);
  });

  it('a reply that arrives while the card is open opens its branch (Claude answering is shown, not folded)', () => {
    const root = at(1, 'USER', 'hey', '2026-10-01T09:00:00Z');
    const fixture = create([root, at(2, 'USER', 'older reply', '2026-10-01T09:01:00Z', 1)]);
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(0);
    fixture.componentRef.setInput('entries', [root, at(2, 'USER', 'older reply', '2026-10-01T09:01:00Z', 1),
      at(3, 'CLAUDE', '**Reply** here I am', '2026-10-01T09:02:00Z', 1)]);
    fixture.detectChanges();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(2);
    expect(fixture.nativeElement.querySelector('.cd-kids').className).toContain('depth-tint-0');
  });

  it('Find opens every reply, so a match never sits in a folded branch', () => {
    const fixture = create([at(1, 'USER', 'root', '2026-10-01T09:00:00Z'), { ...at(2, 'CLAUDE', 'about the SQL', '2026-10-01T09:01:00Z', 1), answers: null }]);
    fixture.componentRef.setInput('query', 'sql');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-kid').length).toBe(1);
  });

  it('shows the parts of a Claude report as blocks, and no heading for a part that only says Reply', () => {
    const fixture = create([e(1, 'CLAUDE', '**Did** ran it\n\n**Found** a bug\n\n**Next** fix it'), e(2, 'CLAUDE', '**Reply** sure')]);
    const heads = [...fixture.nativeElement.querySelectorAll('.cd-ph')].map((h) => (h as HTMLElement).textContent!.trim());
    expect(heads).toEqual(['✓ Did', '⚑ Found', '→ Next']);
    expect(fixture.nativeElement.querySelector('.cd-part-next')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cd-part-reply .cd-ph')).toBeNull();
  });

  it('filters to the changes, gathers a run of them into one line, and finds text in the threads', () => {
    const change = (id: number, when: string): ActivityEntry => ({ id, cardId: 'k', actor: 'USER', kind: 'STATUS', text: null, oldValue: 'INBOX', newValue: 'TO_DO', at: when });
    const fixture = create([change(10, '2026-10-01T08:00:00Z'), change(11, '2026-10-01T08:01:00Z'), at(1, 'USER', 'about the SQL', '2026-10-01T09:00:00Z'),
      at(2, 'USER', 'about the page', '2026-10-01T10:00:00Z')]);
    expect(fixture.nativeElement.querySelector('.cd-changes').textContent).toContain('2 changes');
    fixture.componentRef.setInput('filter', 'changes');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-thread').length).toBe(0);
    fixture.componentRef.setInput('filter', 'all');
    fixture.componentRef.setInput('query', 'sql');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.cd-thread').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.cd-changes')).toBeNull();
  });
});
