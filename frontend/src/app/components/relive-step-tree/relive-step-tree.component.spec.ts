import { ComponentFixture, TestBed } from '@angular/core/testing';
import { defaultCallRule, modeOf } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveStepTreeComponent, reorderTopLevel } from './relive-step-tree.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{}',
  status: 200,
  responseHeaders: {},
  responseBody: '{}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 100,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function makeStep(key: string, parentKey: string | null, label: string): Step {
  return {
    key,
    parentKey,
    label,
    enabled: true,
    optional: false,
    direction: parentKey ? 'outbound' : 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey, label, recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: key, cycleId: null, direction: parentKey ? 'outbound' : 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

/** Two inbound steps: "search" (2 children) and "book" (1 child), in that order. */
function fixtureSteps(): Step[] {
  return [
    makeStep('search', null, 'Search'),
    makeStep('supA', 'search', 'Supplier A'),
    makeStep('supB', 'search', 'Supplier B'),
    makeStep('book', null, 'Book'),
    makeStep('supC', 'book', 'Supplier C'),
  ];
}

describe('reorderTopLevel (pure)', () => {
  it('moves a whole block, children included, and leaves the other block untouched', () => {
    const reordered = reorderTopLevel(fixtureSteps(), 1, 0); // move "book" block before "search"
    expect(reordered.map((s) => s.key)).toEqual(['book', 'supC', 'search', 'supA', 'supB']);
  });
});

describe('ReliveStepTreeComponent', () => {
  let fixture: ComponentFixture<ReliveStepTreeComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveStepTreeComponent] });
    fixture = TestBed.createComponent(ReliveStepTreeComponent);
    fixture.componentRef.setInput('steps', fixtureSteps());
    fixture.componentRef.setInput('settings', settings);
    fixture.detectChanges();
  });

  it('renders one row per inbound step plus its children', () => {
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.rl-step');
    // 2 inbound + 3 children = 5
    expect(rows.length).toBe(5);
  });

  it('a mode button changes modeOf(step.callRule) and emits the updated steps', (done) => {
    fixture.componentInstance.stepsChange.subscribe((updated: readonly Step[]) => {
      const supA = updated.find((s) => s.key === 'supA')!;
      expect(modeOf(supA.callRule)).toBe('LIVE');
      done();
    });

    const liveButtons = Array.from(fixture.nativeElement.querySelectorAll('.rl-seg button')) as HTMLButtonElement[];
    // supA's 3 buttons are REPLAY, LIVE, LIVE_MOCKED, in that order - the first child rendered.
    const liveButton = liveButtons.find((b) => b.textContent?.includes('LIVE ⚠'));
    liveButton!.click();
  });

  it('search filters blocks by label', () => {
    fixture.componentInstance.onSearch('book');
    fixture.detectChanges();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.rl-step');
    expect(rows.length).toBe(2); // "Book" + "Supplier C"
  });
});
