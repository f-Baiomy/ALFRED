import { TestBed } from '@angular/core/testing';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { lineFields, logLevelClass, logRows, togetherRows } from '../../shared/utils/call-log-rows';
import { stmt } from '../../shared/utils/db-capture.fixtures.spec-helper';
import { DbLogLinesComponent } from './db-log-lines.component';

const line = (id: string, offsetMs: number, extra: Partial<LinkedLogLine> = {}): LinkedLogLine => ({
  sourceId: 's1', sourceName: 'server.log', lineId: `in:${id}`, at: '2026-10-06T10:00:00Z', offsetMs, level: 'INFO', thread: 't-1', logger: 'a.B',
  message: `msg ${id}`, matchedBy: 'THREAD_TIME', raw: JSON.stringify({ message: `msg ${id}`, mdc: { alfred: { call: 'c1' } } }), ...extra,
});

describe('DbLogLinesComponent', () => {
  function render(rows: ReturnType<typeof logRows>, multiSource = false) {
    TestBed.configureTestingModule({ imports: [DbLogLinesComponent] });
    const fixture = TestBed.createComponent(DbLogLinesComponent);
    fixture.componentRef.setInput('rows', rows);
    fixture.componentRef.setInput('multiSource', multiSource);
    fixture.detectChanges();
    return fixture;
  }

  it('shows offset, level and message; the source only when the project reads several', () => {
    const one = render(logRows([line('a', -120, { level: 'WARN' })]));
    const row = one.nativeElement.querySelector('.dll-r');
    expect(row.querySelector('.at').textContent).toBe('−120 ms');
    expect(row.querySelector('.v').classList).toContain('lv-warn');
    expect(row.querySelector('.src')).toBeNull();

    TestBed.resetTestingModule();
    const two = render(logRows([line('a', 10, { sourceName: 'app.log' })]), true);
    expect(two.nativeElement.querySelector('.src').textContent).toBe('app.log');
  });

  it('opens a line to its flattened fields with Open in Logs; a kept copy has no link', () => {
    const fixture = render(logRows([line('a', 5), line('k', 6, { kept: true, matchedBy: 'EXACT' })]));
    const rows = fixture.nativeElement.querySelectorAll('.dll-r');
    rows[0].click();
    rows[1].click();
    fixture.detectChanges();
    const details = fixture.nativeElement.querySelectorAll('.dll-detail');
    expect(details[0].textContent).toContain('mdc.alfred.call');
    expect(details[0].querySelector('a').getAttribute('href')).toBe('/logs/s1?line=in%3Aa');
    expect(details[1].querySelector('a')).toBeNull();
    expect(rows[1].textContent).toContain('kept');
    expect(rows[1].textContent).toContain('exact');
  });

  it('shows a caught line with its logger and its exception, and no Logs-tab link (specs/009)', () => {
    const caught = line('c1', 12, {
      sourceId: 'agent', sourceName: 'caught by the agent', lineId: 'c:1', matchedBy: 'CAUGHT', level: 'ERROR', logger: 'com.tt.nc.FlightSearch',
      message: 'search failed', exception: { type: 'java.lang.NullPointerException', message: null, stack: 'java.lang.NullPointerException at a.B(B.java:3)' },
    });
    const fixture = render(logRows([caught]));
    const row = fixture.nativeElement.querySelector('.dll-r');
    expect(row.textContent).toContain('FlightSearch');
    expect(row.textContent).toContain('NullPointerException');
    expect(row.textContent).toContain('caught');
    row.click();
    fixture.detectChanges();
    const detail = fixture.nativeElement.querySelector('.dll-detail');
    expect(detail.querySelector('.dll-ex pre').textContent).toContain('B.java:3');
    expect(detail.querySelector('a')).toBeNull();
  });

  it('emits the seq of a clicked statement row', () => {
    const fixture = render(togetherRows(0, [stmt(7, 'SELECT', 'SELECT 1')], [], new Map(), []));
    let seq = -1;
    fixture.componentInstance.jump.subscribe((s) => (seq = s));
    fixture.nativeElement.querySelector('.dll-r.db').click();
    expect(seq).toBe(7);
  });
});

describe('call-log-rows', () => {
  it('orders statements, supplier calls and lines by time, lines after the call\'s own items at the same instant', () => {
    const start = Date.parse('2026-10-06T10:00:00Z');
    const rows = togetherRows(start, [stmt(1, 'SELECT', 'SELECT 1', { offsetMicros: 50_000 })],
      [{ seq: 2, method: 'POST', url: 'http://sup/x', at: '2026-10-06T10:00:00.080Z' }], new Map(), [line('a', 50), line('b', 10)]);
    expect(rows.map((r) => r.key)).toEqual(['l:s1:in:b', 's:1', 'l:s1:in:a', 'p:2']);
  });

  it('puts caught lines in the call’s own order (seq), whatever their clock says', () => {
    const start = Date.parse('2026-10-06T10:00:00Z');
    const rows = togetherRows(start, [stmt(1, 'SELECT', 'SELECT 1', { offsetMicros: 50_000 }), stmt(3, 'SELECT', 'SELECT 3', { offsetMicros: 60_000 })],
      [], new Map(), [line('a', 90, { seq: 2, matchedBy: 'CAUGHT' })]);
    expect(rows.map((r) => r.key)).toEqual(['s:1', 'l:s1:in:a', 's:3']);
  });

  it('classes levels and flattens JSON lines, leaving other text alone', () => {
    expect(['ERROR', 'SEVERE', 'WARNING', 'TRACE', 'INFO', null].map(logLevelClass)).toEqual(['error', 'error', 'warn', 'debug', 'info', 'info']);
    expect(lineFields('{"a":{"b":1},"c":"x","d":[1]}')).toEqual([{ key: 'a.b', value: '1' }, { key: 'c', value: 'x' }, { key: 'd', value: '[1]' }]);
    expect(lineFields('plain text')).toBeNull();
  });
});
