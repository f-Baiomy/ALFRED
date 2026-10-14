import { TestBed } from '@angular/core/testing';
import { MarkdownViewComponent } from './markdown-view.component';
import { SnippetRunSetting } from '../visuals/snippet-host.component';
import { BoardActionsService } from '../../../core/services/board-actions.service';

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

  it('each paragraph and item reads in its own direction - Arabic right-to-left, English left-to-right, code always left-to-right', () => {
    const el = render(['عمل الـuser الـsearch 9 مرات (POST flight-search/search)، اتنين رجعوا 500.', '', 'The fare is right.', '',
      '- الحجز اتعمل مرتين', '- one more check', '', '```', 'SELECT 1', '```'].join('\n'));
    const ps = Array.from(el.querySelectorAll('p'));
    expect(ps.map((p) => p.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(Array.from(el.querySelectorAll('li')).map((li) => li.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
    expect(el.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
  });

  it('a forced direction (the ⇄ switch) applies to every block', () => {
    const fixture = TestBed.createComponent(MarkdownViewComponent);
    fixture.componentRef.setInput('text', 'عربي\n\nEnglish');
    fixture.componentRef.setInput('dir', 'ltr');
    fixture.detectChanges();
    expect(Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('p')).map((p) => p.getAttribute('dir'))).toEqual(['ltr', 'ltr']);
  });

  it('draws the fixed visual blocks: stats cards, a chart, a timeline, progress, tabs and colour', () => {
    const el = render([
      'It is {green|4× faster}.',
      '',
      '```stats',
      'Median | 2380 → 610 ms | green | ▼ 74%',
      'Errors | 0 → 0',
      '```',
      '',
      '```chart',
      '{"type":"bar","labels":["a","b"],"series":[{"name":"before","values":[2,1]},{"name":"after","values":[1,1]}]}',
      '```',
      '',
      '```timeline',
      'call | 0 | 100 | purple',
      'sql | 10 | 20 | green',
      '```',
      '',
      '[progress: 3/9 re-tested]',
      '',
      ':::tabs',
      '## Before',
      'old way',
      '## After',
      'new way',
      ':::',
    ].join('\n'));
    expect(el.querySelector('.board-md-c-green')!.textContent).toContain('4× faster');
    expect(el.querySelectorAll('.board-stat').length).toBe(2);
    expect(el.querySelector('.board-stat-v.c-green')!.textContent).toContain('610 ms');
    expect(el.querySelectorAll('app-chart-block svg rect[rx="2"]').length).toBe(4);
    expect(el.querySelector('.board-vis-legend')!.textContent).toContain('before');
    expect(el.querySelectorAll('app-timeline-block rect[rx="3"]').length).toBe(2);
    expect((el.querySelector('.board-progress-track i') as HTMLElement).style.width).toBe('33.3333%');
    const tabs = Array.from(el.querySelectorAll('.board-tab')) as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent!.trim())).toEqual(['Before', 'After']);
    expect(el.querySelector('.board-tab-body')!.textContent).toContain('old way');
  });

  it('switches tabs and shows a chart error with its source instead of breaking', () => {
    const fixture = TestBed.createComponent(MarkdownViewComponent);
    fixture.componentRef.setInput('text', ':::tabs\n## A\none\n## B\ntwo\n:::\n\n```chart\nnot json\n```');
    fixture.componentRef.setInput('previews', false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelectorAll('.board-tab')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('.board-tab-body')!.textContent).toContain('two');
    expect(el.querySelector('.board-vis-err')!.textContent).toContain('JSON');
    expect(el.querySelector('.board-vis-src')!.textContent).toContain('not json');
  });

  it('runs an html live block and a diagram in locked frames, and a whole page marked as one', () => {
    TestBed.inject(SnippetRunSetting).onOpen.set(true);
    const el = render('Before\n\n```html live name="Fare" libs="dayjs"\n<b>hi</b>\n```\n\n```mermaid\nflowchart LR\n A --> B\n```');
    expect(el.querySelectorAll('app-snippet-host').length).toBe(2);
    expect(el.querySelector('.snip-name')!.textContent).toContain('Fare');
    expect(el.querySelectorAll('.snip-name')[1].textContent).toContain('Diagram');
    const page = render('<!-- alfred:page -->\n<h1>x</h1>');
    expect(page.querySelectorAll('app-snippet-host').length).toBe(1);
    expect(page.querySelector('.snip.page')).not.toBeNull();
  });

  it('waits for ▶ when snippets are set to run on click', () => {
    TestBed.inject(SnippetRunSetting).onOpen.set(false);
    const el = render('```html live\n<b>hi</b>\n```');
    expect(el.querySelector('.snip-run')).not.toBeNull();
    expect(el.querySelector('iframe')).toBeNull();
    TestBed.inject(SnippetRunSetting).onOpen.set(true);
  });

  describe('choices and action chips (specs/017 R21)', () => {
    let perform: jasmine.Spy;
    function live(text: string, context: Record<string, unknown>, previews = true): HTMLElement {
      perform = jasmine.createSpy('perform').and.resolveTo(true);
      TestBed.configureTestingModule({ providers: [{ provide: BoardActionsService, useValue: { perform } }] });
      const fixture = TestBed.createComponent(MarkdownViewComponent);
      fixture.componentRef.setInput('text', text);
      fixture.componentRef.setInput('previews', previews);
      fixture.componentRef.setInput('snippetContext', context);
      fixture.detectChanges();
      (fixture.nativeElement as HTMLElement).addEventListener('click', () => setTimeout(() => fixture.detectChanges()));
      return fixture.nativeElement as HTMLElement;
    }

    it('on a card, a choice answers through the consent of BoardActionsService and shows as chosen', async () => {
      const el = live('[choose: Per rule | Per session]', { project: 'p', cardId: 'c1', card: 7 });
      const buttons = el.querySelectorAll<HTMLButtonElement>('.board-choice');
      expect(buttons[0].disabled).toBeFalse();
      buttons[1].click();
      await new Promise((r) => setTimeout(r, 10));
      expect(perform).toHaveBeenCalledOnceWith('answer', { choice: 'Per session' }, jasmine.objectContaining({ cardId: 'c1', cardNumber: 7 }), 'This choice');
      expect(el.querySelector('.board-choice.chosen')?.textContent?.trim()).toBe('Per session');
    });

    it('a chip runs its action after consent; off a card (or in a preview) it is only a label', () => {
      const el = live('[action: move FIXED | Mark fixed]', { project: 'p', cardId: 'c1', card: 7 });
      el.querySelector<HTMLButtonElement>('button.board-action-chip.live')!.click();
      expect(perform).toHaveBeenCalledOnceWith('move', { status: 'FIXED' }, jasmine.objectContaining({ cardId: 'c1' }), jasmine.stringMatching(/Mark fixed/));
      TestBed.resetTestingModule();
      const off = live('[action: move FIXED | Mark fixed]\n\n[choose: a | b]', { project: 'p' });
      expect(off.querySelector('button.board-action-chip')).toBeNull();
      expect(off.querySelector<HTMLButtonElement>('.board-choice')!.disabled).toBeTrue();
      TestBed.resetTestingModule();
      const preview = live('[choose: a | b]', { cardId: 'c1' }, false);
      expect(preview.querySelector<HTMLButtonElement>('.board-choice')!.disabled).toBeTrue();
    });
  });
});
