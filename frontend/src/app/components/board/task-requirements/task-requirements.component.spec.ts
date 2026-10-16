import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of } from 'rxjs';
import { CardSummary, ChecklistFile, RequirementsView } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { notesOf, requirementsOf } from '../../../shared/utils/task-view';
import { TaskRequirementsComponent } from './task-requirements.component';

const FILES: ChecklistFile[] = [{ fileName: 'spec.md', items: [
  { key: 'k1', text: 'The Branch dropdown keeps several branches selected at once.', mark: null,
    cards: [{ project: 'p', number: 41, title: 'branch list', status: 'INBOX' }] },
  { key: 'k2', text: 'Searching with one branch returns only that branch\'s requests.', mark: null },
  { key: 'k3', text: 'The Agency dropdown lists "All Agencies".', mark: null,
    suggestion: { cycleId: 'cy', fileName: 'spec.md', itemKey: 'k3', mark: 'PASS', evidence: 'allOption: true in the page', at: '' } },
  { key: 'k4', text: 'Export uses the filters.', mark: { cycleId: 'cy', fileName: 'spec.md', itemKey: 'k4', mark: 'PASS', actor: 'USER',
    evidence: 'exported 2 branches', history: [], updatedAt: '2026-10-12T10:00:00Z' } },
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

function card(number: number, kind: CardSummary['kind'], title: string, extra: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 'c' + number, project: 'p', number, kind, title, status: 'INBOX', resolution: null, reason: null, flags: [], scope: 'NOT_DECIDED',
    author: 'CLAUDE', cycleId: 'cy', cycleDeleted: false, signature: null, createdAt: '', updatedAt: '', updatedBy: 'CLAUDE',
    commentCount: 0, similarClosed: null, description: '', ...extra,
  };
}

const CARDS = [card(41, 'BUG', 'branch list'), card(46, 'NOTE', 'N+1 airports', { flags: ['RISK'] }),
  card(47, 'NOTE', 'Not in the task: AgencyService credential lookup')];

describe('TaskRequirementsComponent (specs/024)', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let ask: jasmine.Spy;

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['mark', 'acceptSuggestion', 'dismissSuggestion', 'putEvidence', 'deleteEvidence']);
    ask = jasmine.createSpy('ask');
    TestBed.configureTestingModule({
      imports: [TaskRequirementsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: NEVER } }, { provide: ChatStateService, useValue: { ask } }],
    });
  });

  function render(editable = true, view: RequirementsView | null = VIEW) {
    const f = TestBed.createComponent(TaskRequirementsComponent);
    const reqs = requirementsOf(FILES, CARDS);
    const notes = notesOf(CARDS, reqs);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('editable', editable);
    f.componentRef.setInput('reqs', reqs);
    f.componentRef.setInput('files', FILES);
    f.componentRef.setInput('view', view);
    f.componentRef.setInput('notes', notes.notes);
    f.componentRef.setInput('notInTask', notes.notInTask);
    f.detectChanges();
    return f;
  }

  const states = (el: HTMLElement) => Array.from(el.querySelectorAll('.tv-req .tv-st')).map((s) => s.textContent);
  const rowOf = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('.tv-req')).find((r) => r.textContent?.includes(text)) as HTMLElement;

  it('groups rows by what they need - decide first, met folded - with the calls\' pill and its reason on hover', () => {
    const el: HTMLElement = render().nativeElement;
    expect(Array.from(el.querySelectorAll('.tv-gh')).map((g) => g.textContent?.replace(/\s+/g, ' ').replace('ⓘ', '').trim()))
      .toEqual(['▾Decide · 1 - Claude suggests a mark; yours decides', '▾Bug · 1 - built but works wrong - a card holds the fix',
        '▾Not checked · 1 - nothing has tried it yet', '▾Met · 1 - done', '▾Also found · 2 - not tied to a requirement']);
    expect(states(el)).toEqual(['✦ CLAUDE SUGGESTS', 'BUG', 'NOT CHECKED']);
    const pills = Array.from(el.querySelectorAll('.tv-calls'));
    expect(pills.map((p) => p.textContent)).toEqual(['checked by hand', 'calls: missing', '0 rows']);
    expect(pills[2].getAttribute('title')).toContain('Add test data and search again - response $.payload has rows - 0 rows');
    expect(Array.from(el.querySelectorAll('.tv-note')).map((n) => Array.from(n.children).map((c) => c.textContent?.trim()).join(' ')))
      .toEqual(['RISK N+1 airports #46', 'NOT IN TASK AgencyService credential lookup #47']);
  });

  it('filter chips show one group, open, or all; Met unfolds', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    expect(Array.from(el.querySelectorAll('.tv-f')).map((c) => c.textContent?.trim()))
      .toEqual(['All 4', 'Open 3', 'Claude suggests 1', 'Bug 1', 'Not checked 1', 'Met 1']);
    (Array.from(el.querySelectorAll('.tv-f')).find((c) => c.textContent?.startsWith('Met')) as HTMLButtonElement).click();
    f.detectChanges();
    expect(states(el)).toEqual(['✓ MET']);
    expect(el.querySelector('.tv-also')).toBeNull();
    (Array.from(el.querySelectorAll('.tv-f')).find((c) => c.textContent?.startsWith('Open')) as HTMLButtonElement).click();
    f.detectChanges();
    expect(states(el)).toEqual(['✦ CLAUDE SUGGESTS', 'BUG', 'NOT CHECKED']);
  });

  it('one control marks a row with the user\'s mark and keeps the evidence', () => {
    api.mark.and.returnValue(of(FILES[0].items[1]));
    const f = render();
    const changed = jasmine.createSpy('changed');
    f.componentInstance.changed.subscribe(changed);
    (rowOf(f.nativeElement, 'one branch').querySelector('.tv-m-FAIL') as HTMLButtonElement).click();
    expect(api.mark).toHaveBeenCalledWith('cy', 'spec.md', 'k2', 'FAIL', '');
    expect(changed).toHaveBeenCalled();
  });

  it('an opened row shows Claude\'s suggestion to accept or dismiss, the calls\' reason and its file', () => {
    api.acceptSuggestion.and.returnValue(of(FILES[0].items[2]));
    api.dismissSuggestion.and.returnValue(of(FILES[0].items[2]));
    const f = render();
    const el: HTMLElement = f.nativeElement;
    (rowOf(el, 'All Agencies').querySelector('.tv-rq') as HTMLElement).click();
    f.detectChanges();
    const row = rowOf(el, 'All Agencies');
    expect(row.querySelector('.tv-sugg')?.textContent).toContain('allOption: true in the page');
    expect(row.querySelector('.tv-kv')?.textContent).toContain('spec.md · AC3');
    (row.querySelector('.tv-accept') as HTMLButtonElement).click();
    expect(api.acceptSuggestion).toHaveBeenCalledWith('cy', 'spec.md', 'k3');
    (Array.from(row.querySelectorAll('.tv-sugg .tv-btn')).find((b) => b.textContent === 'Dismiss') as HTMLButtonElement).click();
    expect(api.dismissSuggestion).toHaveBeenCalledWith('cy', 'spec.md', 'k3');

    (rowOf(el, 'one branch').querySelector('.tv-rq') as HTMLElement).click();
    f.detectChanges();
    expect(rowOf(el, 'one branch').querySelector('.tv-kv')?.textContent).toContain('No data - response $.payload has rows - 0 rows');
  });

  it('the checks editor: lines are parsed, a bad line says why and nothing is sent', () => {
    api.putEvidence.and.returnValue(of(VIEW.items[0].evidence!));
    const f = render();
    const el: HTMLElement = f.nativeElement;
    (rowOf(el, 'several branches').querySelector('.tv-rq') as HTMLElement).click();
    f.detectChanges();
    (Array.from(el.querySelectorAll('.tv-links .board-link')).find((b) => b.textContent?.includes('how the calls show it')) as HTMLButtonElement).click();
    f.detectChanges();
    const area = el.querySelector('.board-evidence-editor textarea') as HTMLTextAreaElement;
    expect(area.value).toBe('shape $.branch* list');
    area.value = 'shape $.branch* list\nbranch is a list';
    area.dispatchEvent(new Event('input'));
    (el.querySelector('.board-evidence-editor .tv-accept') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.putEvidence).not.toHaveBeenCalled();
    expect(el.querySelector('.board-evidence-editor .board-error')?.textContent).toContain('starts with shape, when, match, rows or status');

    area.value = 'shape $.branch* list\nwhen $.branch* list>=2';
    area.dispatchEvent(new Event('input'));
    (el.querySelector('.board-evidence-editor .tv-accept') as HTMLButtonElement).click();
    f.detectChanges();
    expect(api.putEvidence).toHaveBeenCalledWith('cy', jasmine.objectContaining({ fileName: 'spec.md', itemKey: 'k1', project: 'odeysys',
      endpoint: 'POST /x/search', howTo: 'pick 2',
      checks: [{ kind: 'REQUEST_SHAPE', path: '$.branch*', shape: 'list' }, { kind: 'REQUEST_WHEN', path: '$.branch*', shape: 'list>=2' }] }));
    expect(el.querySelector('.board-evidence-editor')).toBeNull();
  });

  it('ask Claude attaches the item to the cycle chat; a card reference opens the card', () => {
    const f = render();
    const el: HTMLElement = f.nativeElement;
    const opened = jasmine.createSpy('opened');
    f.componentInstance.cardOpened.subscribe(opened);
    (rowOf(el, 'several branches').querySelector('.tv-cardref') as HTMLButtonElement).click();
    expect(opened).toHaveBeenCalledWith({ project: 'p', number: 41 });
    f.detectChanges();
    expect(rowOf(el, 'several branches').querySelector('.tv-more')).toBeNull();
    (rowOf(el, 'one branch').querySelector('.tv-rq') as HTMLElement).click();
    f.detectChanges();
    (Array.from(el.querySelectorAll('.tv-links .board-link')).find((b) => b.textContent?.includes('ask Claude')) as HTMLButtonElement).click();
    expect(ask).toHaveBeenCalledWith('odeysys', 'cy', { type: 'spec', ref: 'cy/spec.md#ac2', label: 'AC2 Searching with one branch returns only that branch\'s reques…' });
  });

  it('an Alfred without the requirement check shows the rows without a calls pill; read-only has no controls', () => {
    const el: HTMLElement = render(false, null).nativeElement;
    expect(el.querySelector('.tv-calls')).toBeNull();
    expect(el.querySelectorAll('.tv-req').length).toBe(3);
    expect(el.querySelector('.tv-seg')).toBeNull();
  });
});
