import { TestBed } from '@angular/core/testing';
import { MarkdownViewComponent } from './markdown-view.component';

describe('MarkdownViewComponent', () => {
  function render(text: string): HTMLElement {
    const fixture = TestBed.createComponent(MarkdownViewComponent);
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('previews', false);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows a card description written to the template: facts as pills, sections, a coloured json body and a Next callout', () => {
    const el = render([
      '**The handler throws, so the user gets 405.**',
      '',
      '> 405 x 5 in 6 s · no log line · Galileo',
      '',
      '### Evidence',
      '```json',
      '{"status":405,"error":"METHOD_NOT_ALLOWED"}',
      '```',
      '',
      '### Next',
      'Deploy, then re-test.',
    ].join('\n'));

    expect(el.querySelectorAll('.board-md-section').length).toBe(3);
    const facts = Array.from(el.querySelectorAll('.board-md-fact'));
    expect(facts.map((f) => f.textContent!.trim())).toEqual(['405 x 5 in 6 s', 'no log line', 'Galileo']);
    expect(facts.map((f) => f.className.replace('board-md-fact', '').trim())).toEqual(['bad', 'warn', '']);
    const pre = el.querySelector('.board-md-json')!;
    expect(pre.textContent).toBe('{\n  "status": 405,\n  "error": "METHOD_NOT_ALLOWED"\n}');
    expect(pre.querySelector('.tok-key')!.textContent).toBe('"status"');
    expect(pre.querySelector('.tok-number')!.textContent).toBe('405');
    const callout = el.querySelector('.board-md-callout')!;
    expect(callout.textContent).toContain('Deploy, then re-test.');
    expect(el.querySelectorAll('.board-md-callout').length).toBe(1);
  });

  it('keeps an old free-text description exactly as before: one section, no callout', () => {
    const el = render('The same failure repeats.\n\nNo log line at WARN or above.');
    expect(el.querySelectorAll('.board-md-section').length).toBe(1);
    expect(el.querySelectorAll('p').length).toBe(2);
    expect(el.querySelector('.board-md-callout')).toBeNull();
  });
});
