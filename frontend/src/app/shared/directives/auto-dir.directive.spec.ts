import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AutoDirDirective } from './auto-dir.directive';

@Component({
  standalone: true,
  imports: [AutoDirDirective],
  template: `<div [appAutoDir]="text()">{{ text() }}</div>`,
})
class HostComponent {
  readonly text = signal('');
}

describe('AutoDirDirective', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
  });

  function dirOf(text: string): string | null {
    fixture.componentInstance.text.set(text);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector('div')!.getAttribute('dir');
  }

  it('reads an Arabic sentence that starts with English right-to-left', () => {
    expect(dirOf('Admin بيشيل البلد من البلاد المتحددة للـ item')).toBe('rtl');
  });

  it('reads English left-to-right and leaves text with no letters to the browser', () => {
    expect(dirOf('What does deactivating a country mean?')).toBe('ltr');
    expect(dirOf('#97 · 23')).toBe('auto');
  });
});
