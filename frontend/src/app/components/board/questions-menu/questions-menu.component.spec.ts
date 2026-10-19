import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { QuestionsMenuComponent } from './questions-menu.component';
import { QuestionsFormService } from '../../../core/services/questions-form.service';
import { BulkBarComponent } from '../bulk-bar/bulk-bar.component';

/** specs/037 D2: the open-questions pill is a menu; the selection bar offers the form only when a selected card has an open question. */
describe('questions form on the board', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }));

  function menu() {
    const f = TestBed.createComponent(QuestionsMenuComponent);
    f.componentRef.setInput('boardId', 'b-1');
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('total', 7);
    f.componentRef.setInput('cards', 6);
    f.componentRef.setInput('editable', true);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  const item = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

  it('opens on the pill and offers answering, the form, the cards and the upload', () => {
    const { f, el } = menu();
    expect(el.querySelector('.board-qpill')?.textContent).toContain('7 open questions on 6 cards');
    (el.querySelector('.board-qpill') as HTMLButtonElement).click();
    f.detectChanges();
    expect(item(el, 'Answer them here')).toBeTruthy();
    expect(item(el, 'Questions form: all 7 questions')).toBeTruthy();
    expect(item(el, 'Show the 6 cards')).toBeTruthy();
    expect(item(el, 'Upload answers file')).toBeTruthy();
    let all = 0;
    f.componentInstance.formAll.subscribe(() => all++);
    item(el, 'Questions form').click();
    expect(all).toBe(1);
    f.detectChanges();
    expect(el.querySelector('.qmenu-pop')).toBeNull();
  });

  it('closes on a click outside and on Escape, never on the mouse leaving', () => {
    const { f, el } = menu();
    (el.querySelector('.board-qpill') as HTMLButtonElement).click();
    f.detectChanges();
    el.querySelector('.qmenu')!.dispatchEvent(new MouseEvent('mouseleave'));
    f.detectChanges();
    expect(el.querySelector('.qmenu-pop')).not.toBeNull();
    document.body.click();
    f.detectChanges();
    expect(el.querySelector('.qmenu-pop')).toBeNull();
    (el.querySelector('.board-qpill') as HTMLButtonElement).click();
    f.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    f.detectChanges();
    expect(el.querySelector('.qmenu-pop')).toBeNull();
  });

  it('remembers the language and file type chosen for the board', () => {
    const { f, el } = menu();
    (el.querySelector('.board-qpill') as HTMLButtonElement).click();
    f.detectChanges();
    const [lang, format] = Array.from(el.querySelectorAll('select'));
    lang.value = 'ar';
    lang.dispatchEvent(new Event('change'));
    format.value = 'zip';
    format.dispatchEvent(new Event('change'));
    expect(TestBed.inject(QuestionsFormService).prefs('b-1')).toEqual({ lang: 'ar', format: 'zip' });
  });

  it('the selection bar shows the form only with open questions, and counts questions', () => {
    const f = TestBed.createComponent(BulkBarComponent);
    f.componentRef.setInput('count', 2);
    f.componentRef.setInput('questions', 0);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Questions form');
    f.componentRef.setInput('questions', 3);
    f.detectChanges();
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Questions form'))!;
    expect(btn.textContent?.trim()).toBe('⇩ Questions form (3)');
    let asked = 0;
    f.componentInstance.questionsForm.subscribe(() => asked++);
    btn.click();
    expect(asked).toBe(1);
  });
});
