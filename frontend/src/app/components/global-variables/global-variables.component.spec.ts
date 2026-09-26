import { TestBed } from '@angular/core/testing';
import { GlobalVariablesComponent } from './global-variables.component';
import { GlobalVariablesService } from '../../core/services/global-variables.service';

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
