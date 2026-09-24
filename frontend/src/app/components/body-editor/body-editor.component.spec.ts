import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BodyEditorComponent } from './body-editor.component';

/** A host that feeds edits back, the way every real parent does. */
@Component({
  standalone: true,
  imports: [BodyEditorComponent],
  template: `<app-body-editor
    [value]="value()"
    [readOnly]="readOnly()"
    [openInTabLabel]="tabLabel()"
    (valueChange)="onChange($event)"
    (openInTab)="opened = opened + 1"
  />`,
})
class HostComponent {
  readonly value = signal('');
  readonly readOnly = signal(false);
  readonly tabLabel = signal<string | null>(null);
  readonly emitted: string[] = [];
  opened = 0;

  onChange(value: string): void {
    this.emitted.push(value);
    this.value.set(value);
  }
}

const SOAP =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soap:Body><Search><Origin>CAI</Origin></Search></soap:Body></soap:Envelope>';

describe('BodyEditorComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function setup(value: string, readOnly = false): BodyEditorComponent {
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    host.value.set(value);
    host.readOnly.set(readOnly);
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(BodyEditorComponent)).componentInstance;
  }

  const query = (editor: BodyEditorComponent, text: string) =>
    editor.onQuery({ target: { value: text } } as unknown as Event);

  it('colours JSON with the call cards tokens', () => {
    const editor = setup('{"a":"x","b":2}');
    const classes = editor.editorLines().flatMap((l) => l.tokens.map((t) => t.cls));

    expect(classes).toContain('k');
    expect(classes).toContain('s');
    expect(classes).toContain('n');
    expect(fixture.nativeElement.querySelector('.body-highlight span.k')).not.toBeNull();
  });

  it('colours XML through the XML tokenizer', () => {
    const editor = setup(SOAP);
    const tokens = editor.editorLines().flatMap((l) => l.tokens);

    expect(editor.bodyKind()).toBe('xml');
    expect(tokens.some((t) => t.cls === 'k' && t.text.startsWith('<soap:'))).toBeTrue();
  });

  it('counts i/N with a regex, and the highlight uses the same matcher', () => {
    const editor = setup('{"id1":10,"id2":200,"name":"x"}');
    editor.toggleReplace();
    editor.onRegex({ target: { checked: true } } as unknown as Event);
    query(editor, '\\d{2,}');

    expect(editor.matchLabel()).toBe('1/2');
    editor.step(1);
    expect(editor.matchLabel()).toBe('2/2');
    const marked = editor.editorLines().flatMap((l) => l.tokens).filter((t) => t.highlighted);
    expect(marked.map((t) => t.text)).toEqual(['10', '200']);
  });

  it('applies match case to find too', () => {
    const editor = setup('Seat seat SEAT');
    query(editor, 'seat');
    expect(editor.matches().length).toBe(3);

    editor.onMatchCase({ target: { checked: true } } as unknown as Event);
    expect(editor.matchLabel()).toBe('1/1');
  });

  it('shows a bad regex and disables replace', () => {
    const editor = setup('abc');
    editor.toggleReplace();
    editor.onRegex({ target: { checked: true } } as unknown as Event);
    query(editor, '(a');
    fixture.detectChanges();

    expect(editor.findError()).toBeTruthy();
    expect(editor.canReplace()).toBeFalse();
    expect(fixture.nativeElement.querySelector('.body-editor-find-error')).not.toBeNull();
  });

  it('replaces the current match only, and emits the new value', () => {
    const editor = setup('x-x-x');
    query(editor, 'x');
    editor.step(1);
    editor.onReplacement({ target: { value: 'Y' } } as unknown as Event);
    editor.replaceCurrent();

    expect(host.emitted).toEqual(['x-Y-x']);
  });

  it('replaces all matches, with regex groups, and says how many', () => {
    const editor = setup('a@b c@d');
    editor.toggleReplace();
    editor.onRegex({ target: { checked: true } } as unknown as Event);
    query(editor, '(\\w)@(\\w)');
    editor.onReplacement({ target: { value: '$2@$1' } } as unknown as Event);
    editor.replaceAllMatches();

    expect(host.emitted).toEqual(['b@a d@c']);
    expect(editor.replaceNote()).toBe('Replaced 2');
  });

  it('puts a plain replacement back literally', () => {
    const editor = setup('price');
    query(editor, 'price');
    editor.onReplacement({ target: { value: '$1' } } as unknown as Event);
    editor.replaceAllMatches();

    expect(host.emitted).toEqual(['$1']);
  });

  it('emits pretty text on Format and compact text on Minify', () => {
    const editor = setup('{"a":1}');
    editor.format();
    expect(host.emitted[0]).toBe('{\n  "a": 1\n}');

    fixture.detectChanges();
    editor.minify();
    expect(host.emitted[1]).toBe('{"a":1}');
  });

  it('emits every keystroke', () => {
    const editor = setup('{}');
    editor.onBodyInput({ target: { value: '{"a":' } } as unknown as Event);

    expect(host.emitted).toEqual(['{"a":']);
    expect(editor.validity().state).toBe('invalid');
  });

  it('shows its own edit before any render, and yields to a new value from outside', () => {
    const editor = setup('one');
    // Before the fed-back value has even reached the input, the edited copy is what is shown.
    editor.onBodyInput({ target: { value: 'two' } } as unknown as Event);
    expect(editor.text()).toBe('two');
    fixture.detectChanges();
    expect(editor.text()).toBe('two');

    // A push from outside (the big tab) wins.
    host.value.set('three');
    fixture.detectChanges();
    expect(editor.text()).toBe('three');
  });

  it('shows a revert even when it lands back on the original value', () => {
    const editor = setup('{"a":1}');
    editor.onBodyInput({ target: { value: '{"a":2}' } } as unknown as Event);
    fixture.detectChanges();

    host.value.set('{"a":1}');
    fixture.detectChanges();

    expect(editor.text()).toBe('{"a":1}');
  });

  it('hides every editing control when read-only, and shows Inspect', () => {
    const editor = setup('{"a":1}', true);
    const el = fixture.nativeElement as HTMLElement;

    expect(editor.effectiveMode()).toBe('inspect');
    expect(el.querySelector('.body-modes')).toBeNull();
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('.body-readonly')).not.toBeNull();
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).not.toContain('Format');
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).not.toContain('Replace');
    expect(el.querySelector('app-json-flat-view')).not.toBeNull();
  });

  it('offers Open in a big tab only when given a label', () => {
    setup('{}');
    expect(fixture.nativeElement.querySelector('.body-editor-open-tab')).toBeNull();

    host.tabLabel.set('Open in a big tab');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.body-editor-open-tab') as HTMLButtonElement).click();
    expect(host.opened).toBe(1);
  });
});
