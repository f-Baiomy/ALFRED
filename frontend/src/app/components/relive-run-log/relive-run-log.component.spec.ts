import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LogEntry, Step } from '../../shared/utils/relive-types';
import { ReliveRunLogComponent } from './relive-run-log.component';

const APP = 'http://localhost:9001/app';

const steps = [
  { key: 'login', label: 'Login', direction: 'inbound', enabled: true, recording: { method: 'POST', url: `${APP}/login`, status: 200 } },
  { key: 'book', label: 'Book', direction: 'inbound', enabled: true, recording: { method: 'POST', url: `${APP}/book`, status: 200 } },
] as unknown as Step[];

const log: LogEntry[] = [
  { at: '2026-10-02T10:00:01Z', stepKey: 'login', kind: 'FORWARDED_LIVE', message: `inbound POST ${APP}/login (header, 200)` },
  { at: '2026-10-02T10:00:02Z', stepKey: 'login', kind: 'SENT', message: 'Attempt 1: COMPLETED' },
  { at: '2026-10-02T10:00:03Z', stepKey: 'book', kind: 'RULE_APPLIED', message: 'CALL rule "Book"' },
  { at: '2026-10-02T10:00:03Z', stepKey: 'book', kind: 'FORWARDED_LIVE', message: `inbound POST ${APP}/book (header, 502)` },
  { at: '2026-10-02T10:00:04Z', stepKey: 'book', kind: 'ERROR', message: 'Attempt 1: FAILED - status 502' },
];

describe('ReliveRunLogComponent', () => {
  let fixture: ComponentFixture<ReliveRunLogComponent>;
  let el: HTMLElement;

  beforeEach(() => {
    fixture = TestBed.createComponent(ReliveRunLogComponent);
    fixture.componentRef.setInput('log', log);
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('startedAt', '2026-10-02T10:00:00Z');
    fixture.detectChanges();
    el = fixture.nativeElement;
    el.querySelector('details')!.open = true;
  });

  const rows = () => Array.from(el.querySelectorAll('.rl-log-row'));

  it('shows one row per attempt with its path, answer, status and result', () => {
    expect(rows().length).toBe(2);
    const first = rows()[0].textContent!;
    expect(first).toContain('/app/login');
    expect(first).toContain('Login');
    expect(first).toContain('LIVE');
    expect(first).toContain('200');
    expect(first).toContain('✓ OK');
    expect(first).toContain('+1.0s');
    expect(el.querySelector('summary')!.textContent).toContain('2 entries · 5 events');
  });

  it('filters to problems and searches the rows', () => {
    const problems = Array.from(el.querySelectorAll<HTMLButtonElement>('.rl-log-chip')).find((b) => b.textContent!.includes('Problems'))!;
    expect(problems.textContent).toContain('1');
    problems.click();
    fixture.detectChanges();
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain('/app/book');

    fixture.componentInstance.filter.set('all');
    fixture.componentInstance.query.set('login');
    fixture.detectChanges();
    expect(rows().map((r) => r.textContent)).toEqual([jasmine.stringContaining('/app/login')]);
  });

  it('opens a row to show its events and links to the step', () => {
    const emitted: string[] = [];
    fixture.componentInstance.selectStep.subscribe((key) => emitted.push(key));

    (rows()[1] as HTMLElement).click();
    fixture.detectChanges();
    const details = el.querySelector('.rl-log-details')!.textContent!;
    expect(details).toContain('Rule applied');
    expect(details).toContain('CALL rule "Book"');
    expect(details).toContain('status 502');
    expect(details).toContain(`POST ${APP}/book`);

    el.querySelector<HTMLAnchorElement>('.rl-log-details a')!.click();
    expect(emitted).toEqual(['book']);
  });

  it('hides a step label that only repeats its own call', () => {
    fixture.componentRef.setInput('steps', [{ ...steps[0], label: 'POST /app/login' }, steps[1]]);
    fixture.detectChanges();
    expect(rows()[0].querySelector('.rl-log-step')).toBeNull();
    expect(rows()[1].querySelector('.rl-log-step')!.textContent).toContain('Book');
  });

  it('lists the newest first when asked', () => {
    fixture.componentInstance.newestFirst.set(true);
    fixture.detectChanges();
    expect(rows()[0].textContent).toContain('/app/book');
  });
});
