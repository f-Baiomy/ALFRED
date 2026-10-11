import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivityEntry } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { QuickAnswerComponent } from './quick-answer.component';

@Component({ selector: 'app-mention-editor', standalone: true, template: '<span class="fake-editor"></span>' })
class FakeEditorComponent {
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly rows = input(3);
  readonly submitLabel = input('');
  readonly placeholder = input('');
  readonly card = input<unknown>(null);
  readonly submitted = output<string>();
}

function q(id: number, text: string, actor: 'USER' | 'CLAUDE' = 'CLAUDE', replyTo: number | null = null): ActivityEntry {
  return { id, cardId: 'k', actor, kind: 'COMMENT', text, oldValue: null, newValue: null, at: '2026-10-11T00:00:00Z', replyTo };
}

describe('QuickAnswerComponent', () => {
  let comment: jasmine.Spy;
  let history: ActivityEntry[];

  function create() {
    comment = jasmine.createSpy('comment').and.returnValue(of({}));
    TestBed.configureTestingModule({
      imports: [QuickAnswerComponent],
      providers: [{ provide: BoardApiService, useValue: {
        card: () => of({ id: 'k', project: 'p', number: 11, title: 'PCC', cycleId: null }),
        activity: () => of({ entries: history, total: history.length }),
        comment,
      } }],
    }).overrideComponent(QuickAnswerComponent, { remove: { imports: [MentionEditorComponent] }, add: { imports: [FakeEditorComponent] } });
    const fixture = TestBed.createComponent(QuickAnswerComponent);
    fixture.componentRef.setInput('cardId', 'k');
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  it('shows the open questions one at a time and skips the answered ones', () => {
    history = [q(1, '**Question** Stack vouchers?'), q(2, 'No', 'USER', 1), q(3, '**Question** Name the branch?'), q(4, '**Question** Max two?')];
    const fixture = create();
    expect(fixture.componentInstance.open().map((e) => e.id)).toEqual([3, 4]);
    expect(fixture.nativeElement.textContent).toContain('question 1 of 2');
    expect(fixture.nativeElement.textContent).toContain('Name the branch?');
    fixture.componentInstance.skip();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Max two?');
  });

  it('an answer while other questions stay open does not clear Needs decision', () => {
    history = [q(3, '**Question** A?'), q(4, '**Question** B?')];
    const fixture = create();
    fixture.componentInstance.send(history[0], 'yes');
    expect(comment).toHaveBeenCalledWith('k', 'yes', 3, false);
  });

  it('the last answer clears Needs decision and closes', () => {
    history = [q(4, '**Question** B?')];
    const single = create();
    let closed = false;
    single.componentInstance.closed.subscribe(() => (closed = true));
    single.componentInstance.send(history[0], 'no');
    expect(comment).toHaveBeenCalledWith('k', 'no', 4, true);
    expect(closed).toBeTrue();
  });
});
