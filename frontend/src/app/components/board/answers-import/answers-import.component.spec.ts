import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AnswersImportComponent } from './answers-import.component';
import { QuestionsFormService } from '../../../core/services/questions-form.service';
import { AnswersReport } from '../../../core/models/questions-form.models';

/** specs/037 D18-D19: the report is built from the JSON Alfred read - an uploaded page is never rendered, whatever it holds. */
describe('AnswersImportComponent', () => {
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  const report: AnswersReport = {
    file: { formId: 'qf_1', board: 'b-1', boardName: 'B', answeredBy: evil, role: 'BA', answeredAt: '2026-10-19T14:00:00Z', lang: 'en' },
    rows: [
      { q: 'q1', card: 87, header: 'Viewed', question: 'Who sees New?', choice: [{ id: 'o1', label: 'Per user' }], other: false, later: false, note: evil,
        sure: 'likely', follow: { header: 'Folder', question: null, choice: [{ id: 'o2', label: 'New tab' }] }, result: 'APPLY', message: null },
      { q: 'q2', card: 88, header: 'Link', question: null, choice: [], other: false, later: true, note: 'ask product', sure: null, follow: null, result: 'LATER', message: null },
      { q: 'q3', card: 96, header: 'Columns', question: null, choice: [{ id: 'o1', label: 'Label' }], other: false, later: false, note: '', sure: null, follow: null,
        result: 'CHANGED', message: 'The question was withdrawn or changed since the form was made' },
    ],
    applied: 0, summary: {}, dryRun: true,
  };

  function render() {
    TestBed.configureTestingModule({ imports: [AnswersImportComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    const svc = TestBed.inject(QuestionsFormService);
    const f = TestBed.createComponent(AnswersImportComponent);
    return { f, svc, el: f.nativeElement as HTMLElement };
  }

  it('shows each answer with its result, and counts only the ones that apply on its button', () => {
    const { f, svc, el } = render();
    svc.pending.set({ boardId: 'b-1', fileId: 'f-1', fileName: 'AB1-answers.html', report });
    f.detectChanges();
    const rows = el.querySelectorAll('.aimp-row:not(.aimp-head)');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('Per user');
    expect(rows[0].textContent).toContain('Folder: New tab');
    expect(rows[0].textContent).toContain('will apply');
    expect(rows[1].textContent).toContain('later · stays open');
    expect(rows[2].textContent).toContain('question withdrawn or changed');
    const apply = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Apply'))!;
    expect(apply.textContent?.trim()).toBe('Apply 1 answer');
    spyOn(svc, 'apply').and.resolveTo();
    apply.click();
    expect(svc.apply).toHaveBeenCalled();
  });

  it('never turns text from the file into HTML', () => {
    const { f, svc, el } = render();
    svc.pending.set({ boardId: 'b-1', fileId: 'f-1', fileName: '<b>x</b>.html', report });
    f.detectChanges();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.textContent).toContain('<img src=x');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('Escape and the backdrop close it; a note shows on its own when there is no report', () => {
    const { f, svc, el } = render();
    svc.pending.set({ boardId: 'b-1', fileId: 'f-1', fileName: 'a.html', report });
    f.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    f.detectChanges();
    expect(svc.pending()).toBeNull();
    svc.note.set({ kind: 'error', text: 'Not an Alfred answers file' });
    f.detectChanges();
    expect(el.querySelector('.aimp-toast')?.textContent).toContain('Not an Alfred answers file');
  });
});
