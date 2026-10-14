import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MentionRef } from '../../../core/models/board.models';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';
import { MentionEditorComponent } from './mention-editor.component';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { AskClaudeService } from '../../../core/services/ask-claude.service';

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

  it('a comment or reply: Enter sends, Shift+Enter is a line break', () => {
    const fixture = create();
    const sent: string[] = [];
    fixture.componentInstance.submitted.subscribe((t) => sent.push(t));
    const box = type(fixture, 'a comment');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(fixture.componentInstance.value()).toBe('a comment\n');
    expect(sent).toEqual([]);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent).toEqual(['a comment\n']);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(sent.length).toBe(1);
  });

  it('a long text (enterSends false): Enter is a line break, Ctrl+Enter sends', () => {
    const fixture = create();
    fixture.componentRef.setInput('enterSends', false);
    fixture.detectChanges();
    const sent: string[] = [];
    fixture.componentInstance.submitted.subscribe((t) => sent.push(t));
    const box = type(fixture, 'a description');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(fixture.componentInstance.value()).toBe('a description\n');
    expect(sent).toEqual([]);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(sent).toEqual(['a description\n']);
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

  it('data commands pick real calls and write the blocks that read them live (specs/017 R40)', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    const call = (ref: string, label: string) => ({ type: 'call', ref, label }) as MentionRef;

    c.dataCommand('calls');
    expect(c.pickerOpen()).toBeTrue();
    c.picked({ type: 'card', ref: '12', label: '#12' } as MentionRef);
    expect(c.uploadError()).toContain('Pick a call');
    c.picked(call('in:a1', 'POST /fare/7?x=1 · 500'));
    expect(c.value()).toContain('<pre data-lang="calls">endpoint: POST /fare/7');
    expect(c.value()).toContain('since: 24h');

    c.dataCommand('compare');
    c.picked(call('in:a1', 'POST /fare · 500'));
    expect(c.pickerOpen()).toBeTrue();
    c.picked(call('in:b2', 'POST /fare · 200'));
    expect(c.value()).toContain('<pre data-lang="compare">@[call:in:a1|POST /fare · 500]\n@[call:in:b2|POST /fare · 200]</pre>');

    c.dataCommand('sql');
    c.picked(call('in:a1', 'POST /fare · 500'));
    expect(c.value()).toContain('<pre data-lang="statement">call: in:a1');

    c.dataCommand('call');
    c.picked(call('in:z9', 'GET /x · 200'));
    c.picked(call('in:q1', 'GET /y · 200'));
    expect(c.value()).toContain('!@[call:in:z9|GET /x · 200]');
    expect(c.value()).toContain('@[call:in:q1|GET /y · 200]');
  });

  describe('ask Claude (specs/017 R38)', () => {
    function withAsk(answer: Promise<string>) {
      const send = jasmine.createSpy('send').and.resolveTo('ask-1');
      const cancel = jasmine.createSpy('cancel');
      TestBed.overrideProvider(AskClaudeService, { useValue: { send, cancel, answer: () => answer } });
      const fixture = create();
      return { fixture, send, cancel };
    }

    function select(box: HTMLElement, from: number, to: number): void {
      const node = box.firstChild!;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }

    it('needs a cycle: no ✦ outside one', () => {
      const fixture = create();
      expect(fixture.componentInstance.canAsk()).toBeFalse();
      fixture.componentRef.setInput('cycleId', 'cy');
      fixture.detectChanges();
      expect(fixture.componentInstance.canAsk()).toBeTrue();
    });

    it('sends the selection with the whole text, and the answer replaces only the selection', async () => {
      const { fixture, send } = withAsk(Promise.resolve('WORLD'));
      fixture.componentRef.setInput('cycleId', 'cy');
      const box = type(fixture, 'hello world, bye');
      select(box, 6, 11);
      await fixture.componentInstance.askClaude('Shout it');
      expect(send).toHaveBeenCalledOnceWith(jasmine.objectContaining({ kind: 'EDITOR', question: 'Shout it', cycleId: 'cy',
        data: jasmine.objectContaining({ selection: 'world', text: 'hello world, bye' }) }));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.board-ask-panel')?.textContent).toContain('WORLD');
      fixture.componentInstance.acceptAsk('replace');
      fixture.detectChanges();
      expect(fixture.componentInstance.value()).toContain('hello ');
      expect(fixture.componentInstance.value()).toContain('WORLD');
      expect(fixture.componentInstance.value()).toContain(', bye');
      expect(fixture.componentInstance.value()).not.toContain('world');
      expect(fixture.componentInstance.asked()).toBeNull();
    });

    it('Stop while waiting withdraws the question; Discard keeps the text as it was', async () => {
      const { fixture, cancel } = withAsk(new Promise<string>(() => undefined));
      fixture.componentRef.setInput('cycleId', 'cy');
      type(fixture, 'keep me');
      void fixture.componentInstance.askClaude('Shorten');
      await new Promise((r) => setTimeout(r));
      expect(fixture.componentInstance.asked()?.id).toBe('ask-1');
      fixture.componentInstance.discardAsk();
      expect(cancel).toHaveBeenCalledOnceWith('ask-1');
      expect(fixture.componentInstance.value()).toBe('keep me');
    });
  });
});
