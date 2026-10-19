import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { QuestionsFormService } from './questions-form.service';
import { AppConfigService } from './app-config.service';
import { AnswersReport } from '../models/questions-form.models';

/** specs/037: the board's side of the questions form - download, keep the answers file, dry run first, apply on the user's click. */
describe('QuestionsFormService', () => {
  let svc: QuestionsFormService;
  let http: HttpTestingController;
  let saved: { name: string; blob: Blob }[];

  const report = (dryRun: boolean): AnswersReport => ({
    file: { formId: 'qf_1', board: 'b-1', boardName: 'AB#1 Board', answeredBy: 'Ahmed', role: 'BA', answeredAt: '2026-10-19T14:00:00Z', lang: 'ar' },
    rows: [{ q: 'q1', card: 87, header: 'Viewed', question: 'Who?', choice: [{ id: 'o1', label: 'Per user' }], other: false, later: false, note: '',
      sure: 'sure', follow: null, result: dryRun ? 'APPLY' : 'APPLIED', message: null }],
    applied: dryRun ? 0 : 1, summary: {}, dryRun,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: 'http://alfred' } }],
    });
    svc = TestBed.inject(QuestionsFormService);
    http = TestBed.inject(HttpTestingController);
    saved = [];
    spyOn(URL, 'createObjectURL').and.callFake((b: Blob | MediaSource) => { saved.push({ name: '', blob: b as Blob }); return 'blob:x'; });
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) { saved[saved.length - 1].name = this.download; });
    try { localStorage.removeItem('alfred.questionsForm.b-1'); } catch { /* none */ }
  });

  afterEach(() => http.verify());

  it('downloads the form Alfred builds, in the language and file type remembered for the board, and says what is in it', async () => {
    svc.setPrefs('b-1', { lang: 'ar', format: 'zip' });
    const done = svc.download('b-1', [87, 90]);
    const req = http.expectOne('http://alfred/board/boards/b-1/questions-form');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ cards: [87, 90], lang: 'ar', title: null, format: 'zip' });
    req.flush(new Blob(['PK']), { headers: { 'X-Alfred-Form-Name': 'AB1-questions-2026-10-19.zip', 'X-Alfred-Form-Questions': '2',
      'X-Alfred-Form-Cards': '87', 'X-Alfred-Form-Left-Out': encodeURIComponent('#90 has no open questions') } });
    await done;
    expect(saved[0].name).toBe('AB1-questions-2026-10-19.zip');
    expect(svc.note()?.kind).toBe('warn');
    expect(svc.note()?.text).toContain('2 questions on 1 card');
    expect(svc.note()?.text).toContain('#90 has no open questions');
  });

  it('says why when Alfred refuses, also though the answer came back as a file', async () => {
    const done = svc.download('b-1', [5]);
    http.expectOne('http://alfred/board/boards/b-1/questions-form')
      .flush(new Blob([JSON.stringify({ error: 'invalid', message: 'None of these cards has an open question' })]), { status: 400, statusText: 'Bad Request' });
    await done;
    expect(svc.note()).toEqual({ kind: 'error', text: 'None of these cards has an open question' });
  });

  it('keeps an answers file on the board, dry-runs it, and applies only when asked', async () => {
    const file = new File(['<html></html>'], 'AB1-answers.html', { type: 'text/html' });
    const done = svc.importFile(file, 'b-1', 'odeysys');
    const up = http.expectOne((r) => r.url === 'http://alfred/board/files');
    expect(up.request.params.get('cycle')).toBe('b-1');
    expect(up.request.params.get('project')).toBe('odeysys');
    expect(up.request.params.get('name')).toBe('AB1-answers.html');
    up.flush({ id: 'file-12345678', name: 'AB1-answers.html' });
    await Promise.resolve();
    const dry = http.expectOne('http://alfred/board/boards/b-1/answers-import');
    expect(dry.request.body).toEqual({ fileId: 'file-12345678', dryRun: true });
    dry.flush(report(true));
    await done;
    expect(svc.pending()?.report.rows[0].result).toBe('APPLY');

    const applying = svc.apply();
    const apply = http.expectOne('http://alfred/board/boards/b-1/answers-import');
    expect(apply.request.body).toEqual({ fileId: 'file-12345678', dryRun: false });
    apply.flush(report(false));
    await applying;
    expect(svc.pending()?.report.dryRun).toBeFalse();
    expect(svc.note()?.text).toBe('1 answer recorded on the cards.');
  });

  it('takes only an .html or .zip, at most 2 MB - nothing is sent otherwise', async () => {
    await svc.importFile(new File(['x'], 'notes.txt'), 'b-1', 'p');
    expect(svc.note()?.kind).toBe('error');
    await svc.importFile(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.html'), 'b-1', 'p');
    expect(svc.note()?.text).toBe('An answers file is at most 2 MB');
    http.expectNone(() => true);
  });

  it('remembers the choices for the page even when the browser stores nothing', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    svc.setPrefs('b-2', { lang: 'en', format: 'html' });
    expect(svc.prefs('b-2')).toEqual({ lang: 'en', format: 'html' });
  });
});
