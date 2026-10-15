import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { ChecklistFile, RequirementsView } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { AcceptanceChecklistComponent } from './acceptance-checklist.component';

const FILES: ChecklistFile[] = [{ fileName: 'spec.md', items: [
  { key: 'k1', text: 'The Branch dropdown keeps several branches selected at once.', mark: null },
  { key: 'k2', text: 'Searching with one branch returns only that branch\'s requests.', mark: null },
  { key: 'k3', text: 'The Agency dropdown lists "All Agencies".', mark: null },
] }];

const counts = { contradicts: 0, wrong: 0, meets: 0, noData: 0, unknown: 0 };
const VIEW: RequirementsView = {
  cycleId: 'cy',
  items: [
    { fileName: 'spec.md', itemKey: 'k1', text: '', mark: null, cardNumber: 41, cardStatus: 'INBOX',
      evidence: { cycleId: 'cy', fileName: 'spec.md', itemKey: 'k1', project: 'odeysys', endpoint: 'POST /x/search',
        checks: [{ kind: 'REQUEST_SHAPE', path: '$.branch*', shape: 'list' }], howTo: 'pick 2', updatedBy: 'CLAUDE', updatedAt: null },
      verdict: { verdict: 'MISSING', callId: 'c1', reason: 'request $.branch* is a list - sent branchId: 948', cardId: 'x', judgedAt: null,
        counts: { ...counts, contradicts: 5 } } },
    { fileName: 'spec.md', itemKey: 'k2', text: '', mark: null, cardNumber: null, cardStatus: null, evidence: null,
      verdict: { verdict: 'NO_DATA', callId: 'c1', reason: 'response $.payload has rows - 0 rows', cardId: null, judgedAt: null, counts } },
    { fileName: 'spec.md', itemKey: 'k3', text: '', mark: null, cardNumber: null, cardStatus: null, evidence: null,
      verdict: { verdict: 'MANUAL', callId: null, reason: null, cardId: null, judgedAt: null, counts } },
  ],
  counts: { MISSING: 1, NO_DATA: 1, MANUAL: 1 },
};

describe('AcceptanceChecklistComponent - verdicts by the calls (specs/018)', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let events: Subject<unknown>;

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['checklist', 'requirements', 'putEvidence', 'deleteEvidence', 'mark']);
    api.checklist.and.returnValue(of(FILES));
    api.requirements.and.returnValue(of(VIEW));
    events = new Subject();
    TestBed.configureTestingModule({
      imports: [AcceptanceChecklistComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: events } }],
    });
  });

  function render(editable = true) {
    const f = TestBed.createComponent(AcceptanceChecklistComponent);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('editable', editable);
    f.detectChanges();
    f.detectChanges();
    return f;
  }

  it('shows each item\'s verdict, why, and the counts worst first', () => {
    const el: HTMLElement = render().nativeElement;
    expect(Array.from(el.querySelectorAll('.board-verdict-counts .board-verdict')).map((x) => x.textContent?.trim()))
      .toEqual(['1 missing', '1 no data', '1 manual']);
    expect(Array.from(el.querySelectorAll('li > .board-verdict')).map((x) => x.textContent?.trim())).toEqual(['Missing', 'No data', 'Manual']);
    expect(el.querySelector('li .board-verdict-MISSING')?.getAttribute('title')).toContain('5 calls judged · POST /x/search · card #41');
    expect(el.querySelector('.board-verdict-why')?.textContent).toContain('request $.branch* is a list - sent branchId: 948');
  });

  it('an Alfred without the check shows the checklist as before', () => {
    api.requirements.and.returnValue(throwError(() => new Error('404')));
    const el: HTMLElement = render().nativeElement;
    expect(el.querySelectorAll('.board-check-text').length).toBe(3);
    expect(el.querySelector('.board-verdict')).toBeNull();
    expect(el.querySelector('.board-error')).toBeNull();
  });

  it('the user rewrites an item\'s checks as lines; a bad line says why and nothing is sent', () => {
    api.putEvidence.and.returnValue(of(VIEW.items[0].evidence!));
    const f = render();
    const el: HTMLElement = f.nativeElement;
    (Array.from(el.querySelectorAll('.board-link')).find((b) => b.textContent === 'checks') as HTMLButtonElement).click();
    f.detectChanges();
    const area = el.querySelector('.board-evidence-editor textarea') as HTMLTextAreaElement;
    expect(area.value).toBe('shape $.branch* list');
    area.value = 'shape $.branch* list\nbranch is a list';
    area.dispatchEvent(new Event('input'));
    (el.querySelector('.board-evidence-editor .board-tog') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.putEvidence).not.toHaveBeenCalled();
    expect(el.querySelector('.board-evidence-editor .board-error')?.textContent).toContain('starts with shape, when, match, rows or status');

    area.value = 'shape $.branch* list\nwhen $.branch* list>=2';
    area.dispatchEvent(new Event('input'));
    (el.querySelector('.board-evidence-editor .board-tog') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.putEvidence).toHaveBeenCalledWith('cy', jasmine.objectContaining({ fileName: 'spec.md', itemKey: 'k1', project: 'odeysys',
      endpoint: 'POST /x/search', howTo: 'pick 2',
      checks: [{ kind: 'REQUEST_SHAPE', path: '$.branch*', shape: 'list' }, { kind: 'REQUEST_WHEN', path: '$.branch*', shape: 'list>=2' }] }));
    expect(el.querySelector('.board-evidence-editor')).toBeNull();
  });

  it('a requirements change on the board reloads the verdicts - no polling', () => {
    render();
    expect(api.requirements).toHaveBeenCalledTimes(1);
    events.next({ type: 'board-changed', cycleId: 'cy', what: 'requirements' });
    expect(api.requirements).toHaveBeenCalledTimes(2);
    events.next({ type: 'board-changed', cycleId: 'other', what: 'requirements' });
    expect(api.requirements).toHaveBeenCalledTimes(2);
  });

  it('read-only: no checks editor', () => {
    const el: HTMLElement = render(false).nativeElement;
    expect(Array.from(el.querySelectorAll('.board-link')).some((b) => b.textContent === 'checks')).toBeFalse();
  });
});

void NEVER;
