import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScenarioRunCompareComponent } from './scenario-run-compare.component';
import { ScenarioRun } from '../../shared/utils/scenario-types';

function run(id: string, body: string): ScenarioRun {
  return {
    id, scenarioId: 's1', startedAt: `t-${id}`, finishedAt: `t-${id}`,
    summary: { total: 1, passed: 1, failed: 0, errored: 0 },
    results: {
      draftResults: [{ key: 'd1', attempt: 1, status: 200, durationMs: 5, newCallId: 'c', error: null, response: { status: 200, headers: {}, body }, extracted: {} }],
      assertionResults: {},
    },
  };
}

describe('ScenarioRunCompareComponent', () => {
  let fixture: ComponentFixture<ScenarioRunCompareComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ScenarioRunCompareComponent] }).compileComponents();
    fixture = TestBed.createComponent(ScenarioRunCompareComponent);
    fixture.componentRef.setInput('runs', [run('r1', '{"a":1}'), run('r2', '{"a":2}')]);
    fixture.detectChanges();
  });

  it('prompts to pick two runs before showing anything', () => {
    expect(fixture.nativeElement.textContent).toContain('Pick two runs to compare');
  });

  it('shows field diffs once both runs are selected', () => {
    fixture.componentInstance.selectBefore('r1');
    fixture.componentInstance.selectAfter('r2');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('a: changed');
  });
});
