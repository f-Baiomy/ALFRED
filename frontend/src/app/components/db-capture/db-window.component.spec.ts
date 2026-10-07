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
import { DbWindowState } from './db-window-state';
import { DbWindowService, DbWindowView } from './db-window.service';
import { CallStoreCountsService } from '../../core/state/call-store-counts.service';
import { StoreCommandsPage, StoreCommandSummary } from '../../core/models/store-command.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { CallLogsPage, LinkedLogLine } from '../../core/models/call-logs.model';
import { LogsSocketEvent } from '../../core/models/logs.model';

const call: CallRecord = {
  id: 'call-1', original_url: '/wallet-app/api/wallet/pay', url: '/wallet-app/api/wallet/pay', method: 'POST',
  timestamp: '2026-10-04T18:02:43Z', duration_ms: 420, source: 'internal', service_name: 'wallet-app', state: 'IN_PROGRESS',
};

const EMPTY_REDIS: StoreCommandsPage = { total: 0, commands: [], cold: [], dropped: 0, summary: null };
const redis = (seq: number, over: Partial<StoreCommandSummary> = {}): StoreCommandSummary => ({
  id: seq, store: 'redis', seq, at: `2026-10-04T18:02:43.${String(seq * 10).padStart(3, '0')}Z`, micros: 300, command: 'GET', keys: [`wallet:${seq}`],
  keysTotal: 1, rw: 'r', outcome: 'HIT', replyType: 'BULK', bytes: 10, replyBytes: 20, hasBefore: false, replyPreview: '"ok"', ...over,
});
const redisPage = (...commands: StoreCommandSummary[]): StoreCommandsPage => ({
  total: commands.length, commands, cold: [], dropped: 0,
  summary: { callId: 'call-1', commands: commands.length, reads: 1, writes: 1, hits: 1, misses: 0, failed: commands.filter((c) => c.outcome === 'FAILED').length,
    micros: 600, dropped: 0, live: false, endedEarly: false },
});
const pageOf = (...seqs: number[]): CallStatementsPage => ({
  statements: seqs.map((s) => stmt(s, 'SELECT', `SELECT ${s} FROM t`)), transactions: [], supplierMarkers: [], hasMore: false,
});

describe('DbWindowComponent', () => {
  let events: Subject<DbCaptureSocketEvent>;
  let statements: jasmine.Spy;
  let children: jasmine.Spy;
  let focusGo: jasmine.Spy;
  let logLines: jasmine.Spy;
  let logEvents: Subject<LogsSocketEvent>;
  let storeCommands: jasmine.Spy;

  afterEach(() => {
    logLines = undefined as unknown as jasmine.Spy;
    storeCommands = undefined as unknown as jasmine.Spy;
  });

  let outsideLines: unknown[] = [];

  function create(view?: DbWindowView, outside = false) {
    storeCommands ??= jasmine.createSpy('storeCommands').and.returnValue(of(EMPTY_REDIS));
    children ??= jasmine.createSpy('children').and.returnValue(of([]));
    focusGo = jasmine.createSpy('go');
    events = new Subject();
    logEvents = new Subject();
    logLines ??= jasmine.createSpy('lines').and.returnValue(of(logPage([])));
    TestBed.configureTestingModule({
      imports: [DbWindowComponent],
      providers: [
        { provide: DbCaptureApiService, useValue: { statements, outside: (...args: unknown[]) => statements(...args), outsideLogs: () => of(outsideLines),
          storeCommands: (...args: unknown[]) => storeCommands(...args), storeKeys: () => of([]), settings: () => of({}), redisCli: () => of(''),
          storeCommand: (id: number) => of({ row: redis(id), args: [], resp: 2 }), keyHistory: () => of([]) } },
        { provide: CallStoreCountsService, useValue: { summaries: signal(new Map()), refresh: () => undefined } },
        { provide: DbCaptureStateService, useValue: { events$: events, reconnected$: new Subject(), summaries: signal(new Map()), requestSummary: () => undefined, refreshSummary: () => undefined,
          projectStatus: () => undefined, setLogsOn: jasmine.createSpy('setLogsOn') } },
        { provide: CallLogsApiService, useValue: { lines: (...args: unknown[]) => logLines(...args) } },
        { provide: LogsSocketService, useValue: { events$: logEvents, reconnected$: new Subject() } },
        { provide: CallsStateService, useValue: { calls: signal([]) } },
        { provide: RedactionsStore, useValue: { all: signal([]) } },
        { provide: CallsApiService, useValue: { getChildren: (...args: unknown[]) => children(...args) } },
        { provide: CallFocusService, useValue: { go: (...args: unknown[]) => focusGo(...args) } },
      ],
    });
    const fixture = TestBed.createComponent(DbWindowComponent);
    fixture.componentRef.setInput('request', outside ? { kind: 'outside', project: 'wallet-app' } : { kind: 'call', call, view });
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

  // ---- logs linked to calls (specs/008-logs-call-link) ----

  it('lists the call’s log lines on the Logs view and opens one to its fields', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
    logLines = jasmine.createSpy('lines').and.returnValue(of(logPage([line('a', 40, 'INFO', 'search started'), line('b', 300, 'ERROR', 'boom')])));
    const fixture = create('logs');

    const rows = fixture.nativeElement.querySelectorAll('.dll-r.log');
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain('boom');
    expect(rows[1].classList).toContain('err');
    expect(fixture.nativeElement.querySelector('.dbw-logbar').textContent).toContain('server.log');

    rows[0].click();
    fixture.detectChanges();
    const detail = fixture.nativeElement.querySelector('.dll-detail');
    expect(detail.textContent).toContain('process.thread.name');
    expect(detail.querySelector('a').getAttribute('href')).toBe('/logs/s1?line=in%3Aa');
  });

  it('Together is the statement list with the caught lines at their place - same toolbar, same filters', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of({ ...pageOf(),
      statements: [stmt(2, 'SELECT', 'SELECT 1 FROM wallet'), stmt(5, 'UPDATE', 'UPDATE wallet SET x = 1')] }));
    logLines = jasmine.createSpy('lines').and.returnValue(of({ ...logPage([
      { ...line('a', 40, 'INFO', 'search started'), matchedBy: 'CAUGHT', seq: 1 },
      { ...line('b', 300, 'ERROR', 'boom'), matchedBy: 'CAUGHT', seq: 4 },
    ]), matchedBy: 'CAUGHT' }));
    const fixture = create('together');
    const order = () => [...fixture.nativeElement.querySelectorAll('.r[data-seq], app-db-log-row .dll-r')]
      .map((r: Element) => r.classList.contains('dll-r') ? 'log:' + r.querySelector('.t')!.getAttribute('title') : '#' + r.getAttribute('data-seq'));

    expect(order()).toEqual(['log:search started', '#2', 'log:boom', '#5']);
    expect(fixture.nativeElement.querySelector('.dbw-search')).not.toBeNull(); // the statements toolbar
    expect(fixture.nativeElement.querySelector('.dbw-viewbtn')).not.toBeNull();

    // the same filters: "Failed" keeps error lines, "Writes" hides log lines, the search looks in messages
    const component = fixture.componentInstance as unknown as { state: { kind: { set(k: string): void }; search: { set(q: string): void } } };
    component.state.kind.set('fail');
    fixture.detectChanges();
    expect(order()).toEqual(['log:boom']);
    component.state.kind.set('write');
    fixture.detectChanges();
    expect(order()).toEqual(['#5']);
    component.state.kind.set('all');
    component.state.search.set('started');
    fixture.detectChanges();
    expect(order()).toEqual(['log:search started']);
  });

  it('Redis: its own view with the count, the commands in call order in Together, refetched on a store-commands message for this call', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1, 3)));
    storeCommands = jasmine.createSpy('storeCommands').and.returnValue(of(redisPage(redis(2), redis(4, { command: 'SET', rw: 'w', outcome: 'FAILED', error: 'OOM command not allowed' }))));
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const tab = Array.from(el.querySelectorAll('.views button')).find((b) => b.textContent!.includes('Redis')) as HTMLButtonElement;
    expect(tab.textContent).toContain('2');
    expect(el.textContent).toContain('2 Redis');
    // the timeline's Redis lane: one segment per command, a failed one red; a click opens it in the Redis view
    fixture.componentInstance.timelineHidden.set(false);
    fixture.detectChanges();
    const segs = el.querySelectorAll('.dbt-seg.k-redis, .dbt-seg.k-redis-fail');
    expect(segs.length).toBe(2);
    (el.querySelector('.dbt-seg.k-redis-fail') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.view()).toBe('redis');
    expect((fixture.componentInstance as unknown as { state: DbWindowState }).state.redisOpen().has(4)).toBeTrue();
    fixture.componentInstance.setView('stmts');
    fixture.detectChanges();
    tab.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.rd-row').length).toBe(2);
    expect(el.querySelector('.rd-row.fail')?.textContent).toContain('SET');
    expect(el.textContent).toContain('Showing 2 of 2 Redis commands');
    expect(el.textContent).toContain('Copy as redis-cli');

    fixture.componentInstance.setView('together');
    fixture.detectChanges();
    const order = Array.from(el.querySelectorAll('[data-seq]')).map((n) => Number(n.getAttribute('data-seq')));
    expect(order.filter((s, i) => order.indexOf(s) === i)).toEqual([1, 2, 3, 4]);

    events.next({ type: 'store-commands', callIds: ['other'] } as DbCaptureSocketEvent);
    expect(storeCommands).toHaveBeenCalledTimes(1);
    events.next({ type: 'store-commands', callIds: ['call-1'] } as DbCaptureSocketEvent);
    expect(storeCommands).toHaveBeenCalledTimes(2);
  });

  it('no Redis tab for a call ⬢ was off for', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
    const fixture = create();
    const views = [...fixture.nativeElement.querySelectorAll('.views button')].map((b: Element) => b.textContent!.trim());
    expect(views.some((v) => v.startsWith('Redis') || v.startsWith('Keys'))).toBeFalse();
  });

  it('is a logs-only window for a call the agent captured no statements for', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf()));
    logLines = jasmine.createSpy('lines').and.returnValue(of({ ...logPage([line('a', 5, 'INFO', 'login attempt')]), matchedBy: 'EXACT' }));
    const fixture = create('logs');

    expect(fixture.nativeElement.querySelector('h2').textContent).toContain('Logs · POST');
    expect(fixture.nativeElement.textContent).toContain('no database capture for this call');
    const views = [...fixture.nativeElement.querySelectorAll('.views button')].map((b: Element) => b.textContent!.trim());
    expect(views.length).toBe(1);
    expect(views[0]).toContain('Logs');
    expect(fixture.nativeElement.querySelectorAll('.dll-r.log').length).toBe(1);
  });

  it('says Alfred is not reading the logs while ▤ is off, and offers to turn it on', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
    logLines = jasmine.createSpy('lines').and.returnValue(of({ ...logPage([]), setup: 'LINKING_OFF', matchedBy: null }));
    const fixture = create('logs');

    expect(fixture.nativeElement.querySelector('.dll-empty').textContent).toContain('is not reading');
    expect(fixture.nativeElement.querySelector('.dll-empty button').textContent).toContain('Turn ▤ on');
  });

  it('refetches its lines when the agent caught more for this call (logs-appended), not for another call', () => {
    jasmine.clock().install();
    try {
      statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
      create('logs');
      expect(logLines).toHaveBeenCalledTimes(1);
      events.next({ type: 'logs-appended', callId: 'other', project: 'wallet-app' });
      jasmine.clock().tick(1600);
      expect(logLines).toHaveBeenCalledTimes(1);
      events.next({ type: 'logs-appended', callId: 'call-1', project: 'wallet-app' });
      jasmine.clock().tick(1600);
      expect(logLines).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('outside any call: each thread shows the lines the agent caught there, and threads with lines only', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of({ ...pageOf(), statements: [stmt(1, 'SELECT', 'SELECT 1', { thread: 'sched-1', callId: null })] }));
    outsideLines = [
      { id: 1, at: '2026-10-06T10:00:00.000Z', level: 'INFO', logger: 'org.quartz.Job', thread: 'sched-1', message: 'job fired' },
      { id: 2, at: '2026-10-06T10:00:01.000Z', level: 'WARN', logger: 'boot', thread: 'ServerService Thread Pool -- 7', message: 'deployment slow' },
    ];
    const fixture = create(undefined, true);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('job fired');
    expect(text).toContain('deployment slow');
    expect(text).toContain('log lines only');
    outsideLines = [];
  });

  it('shows "lines not kept" for a caught call over its limits', () => {
    statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
    logLines = jasmine.createSpy('lines').and.returnValue(of({ ...logPage([line('a', 5, 'INFO', 'x')]), matchedBy: 'CAUGHT', dropped: 12 }));
    const fixture = create('logs');

    const bar = fixture.nativeElement.querySelector('.dbw-logbar').textContent;
    expect(bar).toContain('caught by the agent');
    expect(bar).toContain('12 lines not kept');
  });

  it('refetches the lines when the logs socket says new ones arrived - no polling', () => {
    jasmine.clock().install();
    try {
      statements = jasmine.createSpy('statements').and.returnValue(of(pageOf(1)));
      const fixture = create('logs');
      expect(logLines).toHaveBeenCalledTimes(1);
      logEvents.next({ type: 'lines-added', sourceId: 's1', count: 3, newestTs: Date.parse(call.timestamp) + 100 });
      logEvents.next({ type: 'lines-added', sourceId: 's1', count: 2, newestTs: Date.parse(call.timestamp) + 200 });
      jasmine.clock().tick(1600);
      fixture.detectChanges();
      expect(logLines).toHaveBeenCalledTimes(2);
      logEvents.next({ type: 'lines-added', sourceId: 's1', count: 1, newestTs: Date.parse(call.timestamp) - 60_000 });
      jasmine.clock().tick(1600);
      expect(logLines).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });
});

function line(id: string, offsetMs: number, level: string, message: string): LinkedLogLine {
  return {
    sourceId: 's1', sourceName: 'server.log', lineId: `in:${id}`, at: new Date(Date.parse(call.timestamp) + offsetMs).toISOString(), offsetMs, level,
    thread: 'default task-4', logger: 'a.B', message, matchedBy: 'THREAD_TIME',
    raw: JSON.stringify({ message, log: { level }, process: { thread: { name: 'default task-4' } } }),
  };
}

function logPage(lines: LinkedLogLine[]): CallLogsPage {
  return { callId: 'call-1', setup: 'OK', matchedBy: 'THREAD_TIME', thread: 'default task-4', clockSkewMs: 200, lines, next: null };
}
