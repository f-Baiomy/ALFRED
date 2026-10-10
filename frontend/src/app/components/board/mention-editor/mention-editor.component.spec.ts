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
  const attached: HTMLElement[] = [];

  function create() {
    pickForCard = jasmine.createSpy('pickForCard');
    TestBed.configureTestingModule({ imports: [MentionEditorComponent], providers: [{ provide: BoardMentionsService, useValue: { pickForCard } }] })
      .overrideComponent(MentionEditorComponent, { remove: { imports: [MentionPickerComponent] }, add: { imports: [FakePickerComponent] } });
    const fixture = TestBed.createComponent(MentionEditorComponent);
    // Attached, so the selection (the caret) works in the box.
    document.body.appendChild(fixture.nativeElement);
    attached.push(fixture.nativeElement);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => attached.splice(0).forEach((el) => el.remove()));

  function boxOf(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement.querySelector('.board-editor-box');
  }

  /** Puts `text` in the box as typed: one text node, the caret at its end, then the input event. */
  function type(fixture: ReturnType<typeof create>, text: string): HTMLElement {
    const box = boxOf(fixture);
    const node = document.createTextNode(text);
    box.replaceChildren(node);
    box.focus();
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
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

  it('writes the pick in place of the @ - a small pill in the box, the full mention in the value', () => {
    const fixture = create();
    type(fixture, 'see @');
    fixture.componentInstance.insert({ type: 'stmt', ref: 'c1/88', label: 'INSERT | #88' });
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('see @[stmt:c1/88|INSERT \\| #88] ');
    expect(fixture.componentInstance.pickerOpen()).toBeFalse();
    const pill = boxOf(fixture).querySelector('.board-mention-pill') as HTMLElement;
    expect(pill.textContent).toContain('INSERT | #88');
    expect(pill.isContentEditable).toBeFalse();
    expect(boxOf(fixture).textContent).not.toContain('@[');
  });

  it('shows a value given from outside with its mentions as pills, and hands back the same text', () => {
    const fixture = create();
    const text = 'look @[call:in:7b45@d4fc|POST /odeysysadmin/Admin2/loginAction · 200] then\nnext line';
    fixture.componentRef.setInput('value', text);
    fixture.detectChanges();
    const box = boxOf(fixture);
    expect(box.querySelectorAll('.board-mention-pill').length).toBe(1);
    expect(box.textContent).not.toContain('in:7b45');
    box.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.value()).toBe(text);
  });

  it('deleting a pill removes the whole mention from the value', () => {
    const fixture = create();
    fixture.componentRef.setInput('value', 'a @[cycle:c|C] b');
    fixture.detectChanges();
    boxOf(fixture).querySelector('.board-mention-pill')!.remove();
    boxOf(fixture).dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.value()).toBe('a  b');
  });

  it('submits on Ctrl+Enter; a plain Enter is a line break', () => {
    const fixture = create();
    const sent: string[] = [];
    fixture.componentInstance.submitted.subscribe((t) => sent.push(t));
    const box = type(fixture, 'a comment');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(fixture.componentInstance.value()).toBe('a comment\n');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(sent).toEqual(['a comment\n']);
  });

  it('empties the box when the value is cleared after a submit', () => {
    const fixture = create();
    type(fixture, 'sent');
    fixture.componentRef.setInput('value', '');
    fixture.detectChanges();
    expect(boxOf(fixture).textContent).toBe('');
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
