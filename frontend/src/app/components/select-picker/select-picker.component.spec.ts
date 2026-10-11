import { TestBed } from '@angular/core/testing';
import { SelectOption, SelectPickerComponent } from './select-picker.component';

describe('SelectPickerComponent', () => {
  const OPTIONS: SelectOption[] = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Gamma' },
  ];

  function render(inputs: Record<string, unknown>) {
    const f = TestBed.createComponent(SelectPickerComponent);
    f.componentRef.setInput('options', OPTIONS);
    for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
    f.detectChanges();
    return f;
  }

  const button = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.theme-picker-btn')!;

  it('shows the chosen option, the placeholder for an action menu, or the first option like a native select', () => {
    expect(button(render({ value: 'c' }).nativeElement).textContent!.trim()).toBe('Gamma');
    expect(button(render({ value: '', placeholder: '+ team' }).nativeElement).textContent!.trim()).toBe('+ team');
    expect(button(render({ value: '' }).nativeElement).textContent!.trim()).toBe('Alpha');
  });

  it('lists a disabled option without letting it be picked', () => {
    const f = render({ value: 'a' });
    const picked: string[] = [];
    f.componentInstance.valueChange.subscribe((v) => picked.push(v));
    button(f.nativeElement).click();
    f.detectChanges();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.select-picker-panel .filter-option-item'));
    expect(items.map((i) => i.disabled)).toEqual([false, true, false]);
    items[2].click();
    expect(picked).toEqual(['c']);
  });
});
