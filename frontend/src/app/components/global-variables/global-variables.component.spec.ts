import { TestBed } from '@angular/core/testing';
import { GlobalVariablesComponent } from './global-variables.component';
import { GlobalVariablesService } from '../../core/services/global-variables.service';

describe('GlobalVariablesComponent input highlighting', () => {
  let component: GlobalVariablesComponent;
  let input: HTMLInputElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: GlobalVariablesService, useValue: { load: jasmine.createSpy('load') } }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'prefix {{var}} suffix';
    document.body.append(input);
  });

  afterEach(() => input.remove());

  it('shows inline token highlighting with a caret, and leaves native text visible for selection', () => {
    input.focus();
    component.onFocusIn({ target: input } as unknown as FocusEvent);
    expect(component.highlightedControl()).toBe(input);
    expect(input.classList.contains('variable-input-text-hidden')).toBeTrue();
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
    expect(input.classList.contains('variable-input-text-hidden')).toBeTrue();
  });
});

describe('GlobalVariablesComponent rendered input highlight', () => {
  it('keeps ordinary text visible and the token at its native text width', () => {
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
      expect(getComputedStyle(mirror).color).toBe(originalColor);
      expect(getComputedStyle(input).webkitTextFillColor).toBe('rgba(0, 0, 0, 0)');
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
