import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import { CallStatementsPage, DbCaptureSocketEvent } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { CallsStateService } from '../../core/state/calls-state.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { stmt } from '../../shared/utils/db-capture.fixtures.spec-helper';
import { DbWindowComponent } from './db-window.component';
import { DbWindowService } from './db-window.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';

const call: CallRecord = {
  id: 'call-1', original_url: '/wallet-app/api/wallet/pay', url: '/wallet-app/api/wallet/pay', method: 'POST',
  timestamp: '2026-10-04T18:02:43Z', duration_ms: 420, source: 'internal', service_name: 'wallet-app', state: 'IN_PROGRESS',
};

const pageOf = (...seqs: number[]): CallStatementsPage => ({
  statements: seqs.map((s) => stmt(s, 'SELECT', `SELECT ${s} FROM t`)), transactions: [], supplierMarkers: [], hasMore: false,
});

describe('DbWindowComponent', () => {
  let events: Subject<DbCaptureSocketEvent>;
  let statements: jasmine.Spy;
  let children: jasmine.Spy;
  let focusGo: jasmine.Spy;

  function create() {
    children ??= jasmine.createSpy('children').and.returnValue(of([]));
    focusGo = jasmine.createSpy('go');
    events = new Subject();
    TestBed.configureTestingModule({
      imports: [DbWindowComponent],
      providers: [
        { provide: DbCaptureApiService, useValue: { statements } },
        { provide: DbCaptureStateService, useValue: { events$: events, reconnected$: new Subject(), summaries: signal(new Map()), requestSummary: () => undefined } },
        { provide: CallsStateService, useValue: { calls: signal([]) } },
        { provide: RedactionsStore, useValue: { all: signal([]) } },
        { provide: CallsApiService, useValue: { getChildren: (...args: unknown[]) => children(...args) } },
        { provide: CallFocusService, useValue: { go: (...args: unknown[]) => focusGo(...args) } },
      ],
    });
    const fixture = TestBed.createComponent(DbWindowComponent);
    fixture.componentRef.setInput('request', { kind: 'call', call });
    fixture.detectChanges();
    return fixture;
  }

  it('appends the statements a statements-appended message announces, fetching only what is new', () => {
    statements = jasmine.createSpy('statements').and.returnValues(of(pageOf(1, 2)), of(pageOf(3)));
    const fixture = create();
    expect(fixture.nativeElement.querySelectorAll('.r').length).toBe(2);

    events.next({ type: 'statements-appended', callId: 'call-1', lastSeq: 3, summaryChanged: true });
    fixture.detectChanges();

    expect(statements.calls.mostRecent().args).toEqual(['call-1', 2, 500]);
    expect(fixture.nativeElement.querySelectorAll('.r').length).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('Showing 3 of 3 statements');
  });

  it('ignores another call\'s messages and closes on Escape', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
    const fixture = create();
    events.next({ type: 'statements-appended', callId: 'other', lastSeq: 9, summaryChanged: true });
    expect(statements).toHaveBeenCalledTimes(1);

    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBeTrue();
  });

  it('expands a statement on click and shows its SQL with values filled in', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of({
      ...pageOf(), statements: [stmt(1, 'SELECT', 'SELECT name FROM users WHERE id = ?', { params: [[{ type: 'BIGINT', value: '1042' }]] })],
    }));
    const fixture = create();
    fixture.nativeElement.querySelector('.rh').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sqlb').textContent).toContain('WHERE id = 1042');
  });

  it('groups statements by transaction (folded), and shows a plain list with the switch off', () => {
    localStorage.removeItem('alfred.dbCapture.groupByTransaction');
    statements = jasmine.createSpy('statements').and.returnValue(of({
      statements: [stmt(1, 'SELECT', 'SELECT a', { txId: 'tx-1' }), stmt(2, 'SELECT', 'SELECT b', { txId: 'tx-1' })],
      transactions: [{ callId: 'call-1', txId: 'tx-1', firstSeq: 1, lastSeq: 2, outcome: 'OPEN', heldMicros: 0, statementCount: 2, writeCount: 0 }],
      supplierMarkers: [], hasMore: false,
    }));
    const fixture = create();
    expect(fixture.nativeElement.querySelectorAll('.g').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.g').classList).toContain('closed');

    fixture.componentInstance.setGrouped(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.g').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.r').length).toBe(2);
    localStorage.removeItem('alfred.dbCapture.groupByTransaction');
  });

  it('shows the HQL a statement came from, the SQL sent on request, and both in the detail', () => {
    localStorage.removeItem('alfred.dbCapture.rowsAs');
    const origin = { id: 'a:q1', kind: 'HQL' as const, text: 'from Org o where o.id = :id', method: 'list', params: [{ name: ':id', value: '948' }] };
    statements = jasmine.createSpy('statements').and.returnValue(of({
      ...pageOf(),
      statements: [
        stmt(1, 'SELECT', 'SELECT o.NAME FROM TT_ORG o WHERE o.ID = ?', { params: [[{ type: 'BIGINT', value: '948' }]], origin }),
        stmt(2, 'UPDATE', 'UPDATE TT_USER SET X = 1'),
      ],
    }));
    const fixture = create();
    fixture.detectChanges(); // the window publishes "this call has origins" from an effect
    const rows = fixture.nativeElement.querySelectorAll('.r .sql1');
    expect(rows[0].textContent).toContain('HQL');
    expect(rows[0].textContent).toContain('from Org o where o.id = :id');
    expect(rows[1].textContent).toContain('JDBC');

    fixture.componentInstance.setRowsAs('sql');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.r .sql1').textContent).toContain('WHERE o.ID = 948');

    fixture.nativeElement.querySelector('.rh').click();
    fixture.detectChanges();
    const cards = fixture.nativeElement.querySelectorAll('.oc-card');
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain('HQL - the query in your code');
    expect(cards[0].textContent).toContain(':id');
    expect(cards[1].textContent).toContain('WHERE o.ID = 948');
    localStorage.removeItem('alfred.dbCapture.rowsAs');
  });

  it('shows the SQL, not a bare "query", for an HQL query whose text was not recorded', () => {
    localStorage.removeItem('alfred.dbCapture.rowsAs');
    const origin = { id: 'a:q4', kind: 'HQL' as const, method: 'list' };
    statements = jasmine.createSpy('statements').and.returnValue(of({
      ...pageOf(),
      statements: [stmt(1, 'SELECT', 'select user0_.USER_ID from TT_USER user0_', { origin })],
    }));
    const fixture = create();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.r .sql1');
    expect(row.textContent).toContain('HQL');
    expect(row.textContent).toContain('select user0_.USER_ID from TT_USER user0_');
    localStorage.removeItem('alfred.dbCapture.rowsAs');
  });

  it('loads the supplier calls by their parent link - never "not loaded" because the list is filtered', () => {
    const supplier: CallRecord = {
      id: 'out-54', original_url: 'https://ndc.example/api/FlightSearch/Search', url: 'https://ndc.example/api/FlightSearch/Search',
      method: 'POST', timestamp: '2026-10-04T18:02:44Z', duration_ms: 4108, source: 'external', state: 'COMPLETED',
      response: { status: 200, headers: {}, body: '' }, parentCallId: 'call-1', parentSeq: 2,
    };
    children = jasmine.createSpy('children').and.returnValue(of([supplier]));
    statements = jasmine.createSpy('statements').and.returnValue(of({
      ...pageOf(1, 3), supplierMarkers: [{ seq: 2, method: 'POST', url: 'https://ndc.example/api/FlightSearch/Search' }],
    }));
    const fixture = create();
    fixture.detectChanges();
    fixture.detectChanges();
    expect(children).toHaveBeenCalledWith('call-1');
    const sup = fixture.nativeElement.querySelector('div.sup');
    expect(sup.textContent).toContain('4108');
    expect(sup.textContent).toContain('show call');
    expect(sup.textContent).not.toContain('not loaded');

    // "show call": the window is put aside (not destroyed); the call is not on this page, so it is focused there
    const windows = TestBed.inject(DbWindowService);
    windows.openCall(call);
    sup.querySelector('a').click();
    expect(windows.aside()?.label).toContain('#2 POST ndc.example/…/Search');
    expect(windows.request()).not.toBeNull();
    expect(focusGo).toHaveBeenCalledWith({ callId: 'out-54', cycleId: null, direction: 'outbound', serviceName: null });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(windows.request()).not.toBeNull(); // Escape belongs to the page while the window is aside
    windows.back();
    expect(windows.aside()).toBeNull();
    children = undefined as unknown as jasmine.Spy;
  });
});
