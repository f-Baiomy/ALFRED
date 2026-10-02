import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReliveRunCompareComponent } from './relive-run-compare.component';
import { CompareSide, recordingSide, runSide } from '../../shared/utils/relive-run-compare';
import { cmpResult, cmpRun, cmpStep } from '../../shared/utils/relive-run-compare.testing';
import { NoiseRule } from '../../shared/utils/relive-types';

describe('ReliveRunCompareComponent', () => {
  const steps = [cmpStep('login', { label: 'Login' }), cmpStep('search', { label: 'Flight search' }), cmpStep('pax', { label: 'Pax details' })];
  const a = runSide(cmpRun('ra', '2026-10-02T15:40:00Z', steps, [
    cmpResult('login', 'COMPLETED', { status: 200 }),
    cmpResult('search', 'COMPLETED', { status: 200, body: '{"journeys":14}' }),
    cmpResult('pax', 'COMPLETED', { status: 200, body: '{"paxCount":2}' }),
  ], { variableTimeline: [{ name: '$.sid', value: 'one', stepKey: 'login', at: 't' }] }));
  const b = runSide(cmpRun('rb', '2026-10-02T16:16:00Z', steps, [
    cmpResult('login', 'COMPLETED', { status: 200 }),
    cmpResult('search', 'COMPLETED', { status: 200, body: '{"journeys":9}' }),
    cmpResult('pax', 'FAILED', { status: 500, body: '{"message":"boom"}' }),
  ], { variableTimeline: [{ name: '$.sid', value: 'two', stepKey: 'login', at: 't' }] }));

  let fixture: ComponentFixture<ReliveRunCompareComponent>;
  let el: HTMLElement;

  function setup(left: CompareSide = a, right: CompareSide = b): void {
    TestBed.configureTestingModule({ imports: [ReliveRunCompareComponent] });
    fixture = TestBed.createComponent(ReliveRunCompareComponent);
    fixture.componentRef.setInput('a', left);
    fixture.componentRef.setInput('b', right);
    fixture.componentRef.setInput('cycleName', 'Booking');
    fixture.detectChanges();
    el = fixture.nativeElement;
  }

  const rowKeys = () => Array.from(el.querySelectorAll('[data-cmp-key]')).map((r) => r.getAttribute('data-cmp-key'));
  const click = (selector: string) => {
    (el.querySelector(selector) as HTMLElement).click();
    fixture.detectChanges();
  };
  const buttonByText = (text: string) => Array.from(el.querySelectorAll('button')).find((btn) => btn.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;

  it('answers first: the verdict line, then changed steps only', () => {
    setup();
    expect(el.querySelector('.rl-cmp-verdict')?.textContent).toContain('B is worse:');
    expect(el.querySelector('.rl-cmp-verdict')?.textContent).toContain('1 new failure (Pax details)');
    expect(rowKeys()).toEqual(['search', 'pax']);
    buttonByText('All steps')!.click();
    fixture.detectChanges();
    expect(rowKeys()).toEqual(['login', 'search', 'pax']);
  });

  it('a tile filters the table to its verdict', () => {
    setup();
    click('[data-filter="NEW_FAILURE"]');
    expect(rowKeys()).toEqual(['pax']);
  });

  it('a step opens to the fields that changed; Ignore in cycle asks for a noise rule', () => {
    setup();
    let asked: { stepKey: string; rule: NoiseRule } | undefined;
    fixture.componentInstance.ignore.subscribe((e) => (asked = e));
    click('[data-cmp-key="search"]');
    const detail = el.querySelector('.rl-cmp-detail')!;
    expect(detail.textContent).toContain('body.journeys');
    expect(detail.textContent).toContain('14');
    buttonByText('Ignore in cycle')!.click();
    expect(asked).toEqual({ stepKey: 'search', rule: { part: 'body', path: 'body.journeys', auto: false, count: false } });
  });

  it('a field the cycle now ignores no longer makes the step changed', () => {
    setup();
    fixture.componentRef.setInput('cycleNoise', [{ part: 'body', path: 'body.journeys', auto: false, count: false }]);
    fixture.detectChanges();
    expect(rowKeys()).toEqual(['pax']);
  });

  it('Request / Response A vs B opens the interception panel diff', () => {
    setup();
    click('[data-cmp-key="pax"]');
    expect(el.querySelector('app-interception-panel')).toBeNull();
    buttonByText('Response A vs B')!.click();
    fixture.detectChanges();
    expect(el.querySelector('app-interception-panel')).not.toBeNull();
  });

  it('Open in run B names the run and the step', () => {
    setup();
    let opened: { runId: string; stepKey: string } | undefined;
    fixture.componentInstance.openRun.subscribe((e) => (opened = e));
    click('[data-cmp-key="pax"]');
    buttonByText('Open in run B')!.click();
    expect(opened).toEqual({ runId: 'rb', stepKey: 'pax' });
  });

  it('a focus from the matrix opens that step, showing all steps when it is unchanged', async () => {
    setup();
    fixture.componentRef.setInput('focus', { key: 'login' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(rowKeys()).toContain('login');
    expect(el.querySelector('.rl-cmp-row.rl-open')?.getAttribute('data-cmp-key')).toBe('login');
  });

  it('shows the values each run captured side by side', () => {
    setup();
    const table = el.querySelector('.rl-cmp-vars')!;
    expect(table.textContent).toContain('{{$.sid}}');
    expect(table.textContent).toContain('one');
    expect(table.textContent).toContain('two');
    expect(table.textContent).toContain('changed');
  });

  it('against the recording, side A cannot be opened as a run', () => {
    setup(recordingSide(b), b);
    expect(el.querySelector('.rl-cmp-side')?.textContent).toContain('The recording');
    click('[data-cmp-key="pax"]');
    expect(buttonByText('Open in run A')).toBeUndefined();
    expect(buttonByText('Open in run B')).toBeDefined();
  });
});
