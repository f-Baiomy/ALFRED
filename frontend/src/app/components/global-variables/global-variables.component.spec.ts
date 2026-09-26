import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { GlobalVariablesComponent } from './global-variables.component';
import { GlobalVariablesService } from '../../core/services/global-variables.service';
import { BodyEditorComponent } from '../body-editor/body-editor.component';

describe('GlobalVariablesComponent input highlighting', () => {
  let component: GlobalVariablesComponent;
  let input: HTMLInputElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: GlobalVariablesService, useValue: { load: jasmine.createSpy('load'), upsert: jasmine.createSpy('upsert') } }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'prefix {{var}} suffix';
    document.body.append(input);
  });

  afterEach(() => input.remove());

  it('decorates tokens without hiding native input text or selection', () => {
    input.focus();
    component.onFocusIn({ target: input } as unknown as FocusEvent);
    expect(component.highlightedControl()).toBe(input);
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
    expect(component.highlightedParts().map((part) => part.text).join('')).toBe('prefix {{var}} suffix');

    input.value = 'changed {{var}} while focused';
    component.onInput({ target: input } as unknown as Event);
    expect(component.highlightedControl()).toBe(input);
    expect(component.highlightedParts().map((part) => part.text).join('')).toBe('changed {{var}} while focused');
    expect(component.highlightedParts().some((part) => part.token && part.text === '{{var}}')).toBeTrue();

    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    expect(component.highlightedControl()).toBeNull();
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();

    input.setSelectionRange(21, 21);
    component.onKeyUp({ target: input } as unknown as KeyboardEvent);
    expect(component.highlightedControl()).toBe(input);
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
  });

  it('keeps the writable selection when the floating button receives keyboard focus', () => {
    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    expect(component.selectionCanReplace()).toBeTrue();
    component.beginSelectionCreate();
    const button = document.createElement('button');
    button.className = 'selection-variable-button';
    component.onKeyUp({ target: button } as unknown as KeyboardEvent);
    expect(component.selectionCanReplace()).toBeTrue();
    component.selectionName.set('saved');
    component.saveSelectionCreate();
    expect(input.value).toBe('{{saved}} {{var}} suffix');
  });

  it('clears the floating action when creation is cancelled', () => {
    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    component.beginSelectionCreate();
    component.cancelSelectionCreate();
    const button = document.createElement('button');
    button.className = 'variable-modal-backdrop';
    component.onKeyUp({ target: button } as unknown as KeyboardEvent);
    expect(component.selectionText()).toBe('');
    expect(component.selectionCanReplace()).toBeFalse();
  });
});

describe('GlobalVariablesComponent rendered input highlight', () => {
  it('keeps the native glyphs visible and paints only a token background', () => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [{ provide: GlobalVariablesService, useValue: { load: jasmine.createSpy('load') } }],
    });
    const fixture = TestBed.createComponent(GlobalVariablesComponent);
    fixture.detectChanges();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'prefix {{var}} suffix';
    input.style.cssText = 'width:400px;font:16px Arial;color:rgb(234, 234, 245);padding:8px';
    document.body.append(input);
    try {
      const originalColor = getComputedStyle(input).color;
      input.focus();
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      fixture.detectChanges();

      const mirror = fixture.nativeElement.querySelector('.variable-input-highlight') as HTMLElement;
      const token = mirror.querySelector('.variable-highlight-token') as HTMLElement;
      expect(getComputedStyle(input).color).toBe(originalColor);
      expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
      expect(getComputedStyle(token).color).toBe('rgba(0, 0, 0, 0)');
      expect(mirror.textContent?.trim()).toBe(input.value);

      const reference = document.createElement('span');
      reference.textContent = '{{var}}';
      reference.style.cssText = 'font:16px Arial;white-space:pre';
      document.body.append(reference);
      try {
        expect(Math.abs(token.getBoundingClientRect().width - reference.getBoundingClientRect().width)).toBeLessThan(1);
      } finally {
        reference.remove();
      }

      input.setSelectionRange(0, input.value.length);
      input.dispatchEvent(new Event('select', { bubbles: true }));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.variable-input-highlight')).toBeNull();
      expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
    } finally {
      input.remove();
      fixture.destroy();
    }
  });
});

describe('GlobalVariablesComponent the value card only opens over the variable', () => {
  let fixture: ComponentFixture<GlobalVariablesComponent>;
  let input: HTMLInputElement;

  /** Move the pointer to a point, the way a browser would, so the component's own listener runs. */
  const hover = (x: number, y: number) =>
    input.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [
        {
          provide: GlobalVariablesService,
          useValue: {
            load: jasmine.createSpy('load'),
            upsert: jasmine.createSpy('upsert'),
            // The card's own template reads the stored value, so a test that really renders it needs this.
            state: () => ({ variables: { code: '394' } }),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(GlobalVariablesComponent);
    fixture.detectChanges();
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'asdasa {{code}} asddwqweq';
    input.style.cssText = 'width:600px;font:16px Arial;padding:8px';
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();
  });

  afterEach(() => {
    input.remove();
    fixture.destroy();
  });

  it('opens when the pointer is over the variable itself', () => {
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const rect = token.getBoundingClientRect();
    hover(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.input-variable-hover')).not.toBeNull();
  });

  it('stays shut over the empty part of the field, past the end of the text', () => {
    // The reported bug: the pointer sat to the right of the text, in blank field, and the card
    // opened anyway - because the old test was "does the field's VALUE contain a token", which is
    // true wherever the pointer is.
    const field = input.getBoundingClientRect();
    hover(field.right - 20, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
    expect(fixture.nativeElement.querySelector('.input-variable-hover')).toBeNull();
  });

  it('stays shut over the plain text beside the variable', () => {
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const field = input.getBoundingClientRect();
    // Well left of the token, still inside the field.
    hover(token.getBoundingClientRect().left - 30, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  });

  it('closes when the pointer slides off the variable but stays in the field', fakeAsync(() => {
    // mousemove matters here: moving within one input fires no new mouseover, so a
    // mouseover-only test would leave the card open after the pointer left the token.
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const on = token.getBoundingClientRect();
    hover(on.left + on.width / 2, on.top + on.height / 2);
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    hover(on.left - 40, on.top + on.height / 2);
    // Closing is a deliberate 220ms timer, so it is not immediate.
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    tick(221);
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  }));

  it('does not open for a field with no variable in it', () => {
    input.value = 'nothing to see';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const field = input.getBoundingClientRect();
    hover(field.left + 10, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  });
});

describe('GlobalVariablesComponent inserting a variable into a body editor', () => {
  let overlay: ComponentFixture<GlobalVariablesComponent>;
  let editor: ComponentFixture<BodyEditorComponent>;
  let area: HTMLTextAreaElement;

  /** Type into the body editor the way a user would, so the overlay sees the same input event. */
  const type = (value: string, caret: number) => {
    area.focus();
    area.value = value;
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    editor.detectChanges();
    overlay.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent, BodyEditorComponent],
      providers: [
        {
          provide: GlobalVariablesService,
          useValue: {
            load: jasmine.createSpy('load'),
            entries: () => [{ name: 'code', value: '394' }],
            state: () => ({ variables: { code: '394' }, fallbacks: {} }),
          },
        },
      ],
    });
    overlay = TestBed.createComponent(GlobalVariablesComponent);
    overlay.detectChanges();
    editor = TestBed.createComponent(BodyEditorComponent);
    editor.componentRef.setInput('value', '{"a":"heyjuada"}');
    // The rule editor feeds every edit straight back through [value] - patchMatchTest updates
    // the row, and the row feeds the binding. Without this round-trip the bug cannot show: the
    // thing that moves the caret is the binding writing the value the DOM already holds.
    editor.componentInstance.valueChange.subscribe((text) => editor.componentRef.setInput('value', text));
    editor.detectChanges();
    area = editor.nativeElement.querySelector('textarea');
  });

  afterEach(() => {
    overlay.destroy();
    editor.destroy();
  });

  it('leaves the caret just past the inserted token, not on the closing quote', () => {
    // The reported bug: after picking a variable the caret sat ON the closing quote, so the
    // next thing typed went outside the string and the JSON broke.
    type('{"a":"heyjuada{{"}', 16);
    const option = overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement;
    expect(option).not.toBeNull();
    option.click();
    editor.detectChanges();

    expect(area.value).toBe('{"a":"heyjuada{{code}}"}');
    // 22 is just past "}}". 21 is the closing quote - where the caret used to land.
    expect(area.selectionStart).toBe(22);
    expect(area.selectionEnd).toBe(22);
  });

  it('emits the edit exactly once per change, so the parent stores the text that is on screen', () => {
    const seen: string[] = [];
    editor.componentInstance.valueChange.subscribe((text) => seen.push(text));
    type('{"a":"heyjuada{{"}', 16);
    // Typing the "{{" is one edit; accepting the suggestion is another. Each is emitted once -
    // the insert must not re-emit the text the editor already holds.
    expect(seen).toEqual(['{"a":"heyjuada{{"}']);
    (overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement).click();
    expect(seen).toEqual(['{"a":"heyjuada{{"}', '{"a":"heyjuada{{code}}"}']);
  });

  it('reuses closing braces already typed in the JSON editor', () => {
    type('{"a":"heyjuada{{}}"}', 16);
    (overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement).click();
    editor.detectChanges();

    expect(area.value).toBe('{"a":"heyjuada{{code}}"}');
    expect(area.selectionStart).toBe(22);
  });
});
