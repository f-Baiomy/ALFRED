import { Component, input, output } from '@angular/core';
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
  readonly rows = input(3);
  readonly cancellable = input(false);
  readonly submitLabel = input('Comment');
  readonly placeholder = input('');
  readonly submitted = output<string>();
  readonly cancelled = output<void>();
}

function e(id: number, actor: ActivityEntry['actor'], text: string, replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-10T09:00:00Z', replyTo };
}

describe('ActivityTimelineComponent', () => {
  function create(entries: ActivityEntry[], editable = true) {
    TestBed.configureTestingModule({ imports: [ActivityTimelineComponent], providers: [{ provide: BoardMentionsService, useValue: {} }] })
      .overrideComponent(ActivityTimelineComponent, { remove: { imports: [MentionEditorComponent] }, add: { imports: [FakeEditorComponent] } });
    const fixture = TestBed.createComponent(ActivityTimelineComponent);
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
    return fixture;
  }

  function buttons(fixture: ReturnType<typeof create>): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('.board-ev-acts button')];
  }

  it('shows replies under their comment, and an open question with Answer', () => {
    const fixture = create([e(1, 'USER', 'why?'), e(2, 'CLAUDE', '**Reply** because', 1), e(3, 'CLAUDE', '**Question** which?')]);
    expect(fixture.nativeElement.querySelectorAll('.board-ev-reply').length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('1 reply');
    expect(fixture.nativeElement.querySelector('.board-ev-badge').textContent).toContain('waiting for you');
    expect(buttons(fixture).map((b) => b.textContent!.trim())).toContain('↩ Answer');
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
    expect(fixture.nativeElement.querySelectorAll('.board-ev-reply').length).toBe(1);
    expect(buttons(fixture).length).toBe(0);
  });
});
