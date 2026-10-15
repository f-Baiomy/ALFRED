import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CardDetail, CardRetest, RetestCheck, expectationText, retestChip, suggestExpectations } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { ResendApiService } from '../../../core/services/resend-api.service';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { CardRetestComponent } from './card-retest.component';

@Component({ selector: 'app-mention-chip', standalone: true, template: '<span>{{ mention().label }}</span>' })
class FakeChipComponent {
  readonly mention = input.required<{ label: string }>();
  readonly showPreview = input(true);
}

function check(over: Partial<RetestCheck> = {}): RetestCheck {
  return {
    number: 19, project: 'odeysys', title: 'N+1 TT_COUNTRY_AIRLINE_MAP', status: 'FIXED', since: '2026-10-11T00:00:00Z', verdict: 'PASSES',
    statusOnly: false, summary: 'passes · 3 calls since the fix', newBuild: false,
    results: [{ text: '≤ 3 queries on TT_COUNTRY_AIRLINE_MAP', expectation: { kind: 'SQL_COUNT', table: 'TT_COUNTRY_AIRLINE_MAP', max: 3 }, outcome: 'PASS',
      before: '257', after: ['3', '3', '3'], note: null }],
    calls: [{ ref: 'in:a1', label: 'POST /Admin2/agency/by-branch · 200', at: null, passed: true, failed: null }],
    steps: [{ text: 'Open the flight search page', endpoint: 'POST /Admin2/agency/by-branch', seen: true, calls: 3 }],
    ...over,
  };
}

function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: 'k', project: 'odeysys', number: 19, kind: 'NOTE', title: 'N+1: country list loads TT_COUNTRY_AIRLINE_MAP per country (257 queries)', status: 'FIXED',
    resolution: null, reason: null, flags: [], scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: null, cycleDeleted: false, signature: 'ok|POST /x',
    createdAt: '', updatedAt: '', updatedBy: 'CLAUDE', commentCount: 0, similarClosed: null, description: '',
    links: [{ type: 'call', ref: 'in:orig', label: 'POST /Admin2/agency/by-branch · 200' }], ...over,
  } as CardDetail;
}

describe('re-test helpers', () => {
  it('shows a chip per verdict, a guard on a Verified card', () => {
    expect(retestChip(check()).tone).toBe('pass');
    expect(retestChip(check({ verdict: 'FAILS', summary: 'fails · x' })).text).toBe('✗ fails · x');
    expect(retestChip(check({ verdict: 'NO_CALLS', newBuild: true, calls: [] })).text).toBe('⟳ new build · ready to re-test');
    expect(retestChip(check({ status: 'VERIFIED', verdict: 'FAILS', summary: 'fails · 212 queries' })).text).toBe('⚠ guard failed · 212 queries');
  });

  it('suggests expectations from what the card is about', () => {
    const n1 = suggestExpectations({ kind: 'NOTE', title: 'N+1: country list loads TT_COUNTRY_AIRLINE_MAP per country (257 queries)' });
    expect(n1.map(expectationText)).toContain('≤ 3 queries on TT_COUNTRY_AIRLINE_MAP');
    const hidden = suggestExpectations({ kind: 'BUG', title: 'upselling error hidden behind 405' });
    expect(hidden.map(expectationText)).toEqual(['Status not 405', 'No ERROR log line']);
    const slow = suggestExpectations({ kind: 'NOTE', title: 'Airline list slow: 5.7 s' });
    expect(slow.map(expectationText)).toContain('Under 1000 ms (3 calls)');
  });
});

describe('CardRetestComponent', () => {
  let data: CardRetest;
  let setPlan: jasmine.Spy;
  let move: jasmine.Spy;
  let resend: jasmine.Spy;
  let confirm: jasmine.Spy;

  function create(c: CardDetail = card()) {
    setPlan = jasmine.createSpy('setRetestPlan').and.returnValue(of({}));
    move = jasmine.createSpy('move').and.returnValue(of({}));
    resend = jasmine.createSpy('resend').and.returnValue(of({ newCallId: 'n', status: 200, durationMs: 300, sessionValuesUsed: [], response: null }));
    confirm = jasmine.createSpy('confirm').and.returnValue(Promise.resolve(true));
    TestBed.configureTestingModule({
      imports: [CardRetestComponent],
      providers: [
        { provide: BoardApiService, useValue: { cardRetest: () => of(data), setRetestPlan: setPlan, move, retestRun: () => of({ checks: [] }) } },
        { provide: ResendApiService, useValue: { resend } },
        { provide: ConfirmDialogService, useValue: { confirm } },
      ],
    }).overrideComponent(CardRetestComponent, { remove: { imports: [MentionChipComponent] }, add: { imports: [FakeChipComponent] } });
    const fixture = TestBed.createComponent(CardRetestComponent);
    fixture.componentRef.setInput('card', c);
    fixture.detectChanges();
    fixture.detectChanges(); // the effect loaded the re-test in the first pass
    return fixture;
  }

  beforeEach(() => {
    data = { plan: { cardId: 'k', expectations: [{ kind: 'SQL_COUNT', table: 'TT_COUNTRY_AIRLINE_MAP', max: 3 }], steps: [{ text: 'Open the flight search page' }],
      updatedBy: 'CLAUDE', updatedAt: null }, check: check(), history: [], lastStart: null };
  });

  it('shows each expectation before → now and accepts Verified when everything passes', async () => {
    const f = create();
    const text = f.nativeElement.textContent as string;
    expect(text).toContain('≤ 3 queries on TT_COUNTRY_AIRLINE_MAP');
    expect(text).toContain('257');
    expect(text).toContain('3 · 3 · 3');
    const accept = [...f.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent?.includes('Accept Verified')) as HTMLButtonElement;
    expect(accept.disabled).toBeFalse();
    accept.click();
    await f.whenStable(); // the Verified guard reads the re-test first (specs/020)
    await new Promise((r) => setTimeout(r));
    expect(move).toHaveBeenCalledWith('k', 'VERIFIED');
  });

  it('cannot accept Verified while a check is open', () => {
    data = { ...data, check: check({ verdict: 'PARTIAL' }) };
    const f = create();
    const accept = [...f.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent?.includes('Accept Verified')) as HTMLButtonElement;
    expect(accept.disabled).toBeTrue();
  });

  it('adds a suggested expectation to the plan, keeping the steps', () => {
    const f = create();
    const add = [...f.nativeElement.querySelectorAll('button.board-copy')].find((b: HTMLButtonElement) => b.textContent?.includes('No ERROR')) as HTMLButtonElement
      ?? [...f.nativeElement.querySelectorAll('button.board-copy')][0] as HTMLButtonElement;
    add.click();
    expect(setPlan).toHaveBeenCalled();
    const [id, expectations, steps] = setPlan.calls.mostRecent().args;
    expect(id).toBe('k');
    expect(expectations.length).toBe(2);
    expect(steps).toEqual([{ text: 'Open the flight search page' }]);
  });

  it('asks before replaying a call that writes', async () => {
    const f = create();
    await f.componentInstance.replay();
    expect(confirm).toHaveBeenCalled();
    expect(resend).toHaveBeenCalledWith({ direction: 'inbound', callId: 'orig', cycleId: null });
  });

  it('replays a GET without asking', async () => {
    const f = create(card({ links: [{ type: 'call', ref: 'in:g1@cy', label: 'GET /odeysysadmin/Master2/airline · 200' }] }));
    await f.componentInstance.replay();
    expect(confirm).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledWith({ direction: 'inbound', callId: 'g1', cycleId: 'cy' });
  });
});
