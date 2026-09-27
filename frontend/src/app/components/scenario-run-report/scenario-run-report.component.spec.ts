import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScenarioRunReportComponent } from './scenario-run-report.component';
import { DraftResult } from '../../shared/utils/scenario-types';

describe('ScenarioRunReportComponent', () => {
  let fixture: ComponentFixture<ScenarioRunReportComponent>;

  const results: DraftResult[] = [
    { key: 'd1', attempt: 1, status: 200, durationMs: 5, newCallId: 'c1', error: null, response: { status: 200, headers: {}, body: '{"ok":true}' }, extracted: {} },
    { key: 'd2', attempt: 1, status: 500, durationMs: 9, newCallId: 'c2', error: 'boom', response: { status: 500, headers: {}, body: 'oops' }, extracted: {} },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ScenarioRunReportComponent] }).compileComponents();
    fixture = TestBed.createComponent(ScenarioRunReportComponent);
    fixture.componentRef.setInput('scenarioName', 'Book flow');
    fixture.componentRef.setInput('draftResults', results);
    fixture.componentRef.setInput('assertionResults', {});
    fixture.detectChanges();
  });

  it('shows the pass/fail summary', () => {
    expect(fixture.nativeElement.textContent).toContain('1 / 2 drafts passed');
  });

  it('renders one row per draft result', () => {
    expect(fixture.nativeElement.querySelectorAll('.scenario-report-row').length).toBe(2);
  });

  it('a failed row is expanded by default and shows its full body', () => {
    const failedRow = fixture.nativeElement.querySelectorAll('.scenario-report-row')[1];
    expect(failedRow.querySelector('.scenario-report-body')).toBeTruthy();
    expect(failedRow.textContent).toContain('oops');
  });

  it('a passed row is collapsed by default', () => {
    const passedRow = fixture.nativeElement.querySelectorAll('.scenario-report-row')[0];
    expect(passedRow.querySelector('.scenario-report-body')).toBeFalsy();
  });

  it('toggling a row flips its expanded state', () => {
    const passedRow = fixture.nativeElement.querySelectorAll('.scenario-report-row')[0];
    (passedRow.querySelector('.scenario-report-row-header') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(passedRow.querySelector('.scenario-report-body')).toBeTruthy();
  });
});
