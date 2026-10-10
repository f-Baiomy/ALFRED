import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MentionRef } from '../../../core/models/board.models';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';
import { MentionEditorComponent } from './mention-editor.component';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';

/** The real picker needs the backend; the editor's behaviour is what it does with a pick. */
@Component({ selector: 'app-mention-picker', standalone: true, template: '<span class="fake-picker"></span>' })
class FakePickerComponent {
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly calls = input<readonly MentionRef[]>([]);
  readonly canPickAnywhere = input(false);
  readonly pickAnywhere = output<void>();
  readonly picked = output<MentionRef>();
  readonly closed = output<void>();
}

describe('MentionEditorComponent', () => {
  let pickForCard: jasmine.Spy;

  function create() {
    pickForCard = jasmine.createSpy('pickForCard');
    TestBed.configureTestingModule({ imports: [MentionEditorComponent], providers: [{ provide: BoardMentionsService, useValue: { pickForCard } }] })
      .overrideComponent(MentionEditorComponent, { remove: { imports: [MentionPickerComponent] }, add: { imports: [FakePickerComponent] } });
    const fixture = TestBed.createComponent(MentionEditorComponent);
    fixture.detectChanges();
    return fixture;
  }

  function type(fixture: ReturnType<typeof create>, text: string): HTMLTextAreaElement {
    const box: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
    box.value = text;
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return box;
  }

  it('opens the picker when @ is typed after a space, and not inside a word', () => {
    const fixture = create();
    type(fixture, 'mail@');
    expect(fixture.nativeElement.querySelector('.fake-picker')).toBeNull();
    type(fixture, 'see @');
    expect(fixture.nativeElement.querySelector('.fake-picker')).not.toBeNull();
  });

  it('writes the pick in place of the @ as a mention', () => {
    const fixture = create();
    type(fixture, 'see @');
    fixture.componentInstance.insert({ type: 'stmt', ref: 'c1/88', label: 'INSERT | #88' });
    expect(fixture.componentInstance.value()).toBe('see @[stmt:c1/88|INSERT \\| #88] ');
    expect(fixture.componentInstance.pickerOpen()).toBeFalse();
  });

  it('submits on Ctrl+Enter', () => {
    const fixture = create();
    const sent: string[] = [];
    fixture.componentInstance.submitted.subscribe((t) => sent.push(t));
    const box = type(fixture, 'a comment');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(sent).toEqual(['a comment']);
  });

  it('offers the calls the text mentions to the statement and log tabs', () => {
    const fixture = create();
    type(fixture, 'see @[call:in:x1|POST] and @[cycle:c|C]');
    expect(fixture.componentInstance.callMentions().map((m) => m.ref)).toEqual(['in:x1']);
  });

  it('"Pick from anywhere" from the comment box takes the text along without its @, and where the @ was', () => {
    const fixture = create();
    fixture.componentRef.setInput('card', { id: 'k1', project: 'p', number: 7, cycleId: null });
    fixture.componentRef.setInput('pickField', 'comment');
    type(fixture, 'see @');

    fixture.componentInstance.pickFromAnywhere();

    expect(pickForCard).toHaveBeenCalledWith({ id: 'k1', project: 'p', number: 7, cycleId: null },
      { kind: 'text', field: 'comment', text: 'see ', at: 4 });
    expect(fixture.componentInstance.pickerOpen()).toBeFalse();
  });
});
