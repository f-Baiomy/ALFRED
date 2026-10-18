import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CloseOnOutsideDirective } from './close-on-outside.directive';

@Component({
  standalone: true,
  imports: [CloseOnOutsideDirective],
  template: `
    <div class="wrap" [appCloseOnOutside]="open()" (closed)="closes = closes + 1">
      <button class="trigger">▾</button>
      @if (open()) { <div class="menu"><button class="item">Pause</button></div> }
    </div>
    <div class="outside">elsewhere</div>
    <div data-keep-menu><button class="dialog-btn">Hand back</button></div>`,
})
class HostComponent {
  readonly open = signal(true);
  closes = 0;
}

describe('CloseOnOutsideDirective', () => {
  function make() {
    const f = TestBed.createComponent(HostComponent);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const down = (sel: string) => el.querySelector(sel)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return { f, el, down };
  }

  it('closes on a click outside, never on the menu, its trigger, or a kept dialog', () => {
    const { f, el, down } = make();
    document.body.appendChild(el);
    down('.item');
    down('.trigger');
    down('.dialog-btn');
    expect(f.componentInstance.closes).toBe(0);
    down('.outside');
    expect(f.componentInstance.closes).toBe(1);
    el.remove();
  });

  it('does nothing on mouseleave, closes on Escape, and stays quiet while not armed', () => {
    const { f, el, down } = make();
    document.body.appendChild(el);
    el.querySelector('.wrap')!.dispatchEvent(new MouseEvent('mouseleave'));
    expect(f.componentInstance.closes).toBe(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(f.componentInstance.closes).toBe(1);
    f.componentInstance.open.set(false);
    f.detectChanges();
    down('.outside');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(f.componentInstance.closes).toBe(1);
    el.remove();
  });
});
