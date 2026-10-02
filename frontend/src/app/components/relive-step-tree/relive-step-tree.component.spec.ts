import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
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
    TestBed.configureTestingModule({
      imports: [ReliveStepTreeComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
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

  it('shows the recorded method and path with the inbound live-app badge', () => {
    const inbound: HTMLElement = fixture.nativeElement.querySelector('.rl-step:not(.rl-child)');
    expect(inbound.querySelector('.rl-step-number')?.textContent?.trim()).toBe('1');
    expect(inbound.querySelector('.rl-method')?.textContent?.trim()).toBe('POST');
    expect(inbound.textContent).toContain('/v2/search');
    expect(inbound.textContent).toContain('APP · LIVE');
  });

  it('offers an actionable add-calls link when the cycle is empty', () => {
    fixture.componentRef.setInput('steps', []);
    fixture.detectChanges();
    const request = jasmine.createSpy('add calls');
    fixture.componentInstance.addCallsRequested.subscribe(request);
    (fixture.nativeElement.querySelector('.rl-link') as HTMLButtonElement).click();
    expect(request).toHaveBeenCalled();
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

  it('opens the logged call card under the selected step', () => {
    fixture.componentRef.setInput('selectedKey', 'search');
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne((call) => call.url.includes('/internal-calls/search/summary'));
    req.flush({
      id: 'search',
      original_url: 'https://api.supplier-a.com/v2/search',
      url: 'https://api.supplier-a.com/v2/search',
      method: 'POST',
      timestamp: '2026-09-27T10:00:00Z',
      duration_ms: 100,
      status: 200,
      service_name: 'odeysys',
      resend_of: 'bf7dc95e-1111-2222-3333-444444444444',
      resend_edits: { headers: ['Cookie'], body: true },
      interception: {
        applied: [{ ruleName: 'set sessionid', action: 'SET_REQUEST_COOKIE', detail: 'JSESSIONID' }],
        originalRequest: { method: 'POST', url: 'https://api.supplier-a.com/v2/search', headers: { Cookie: 'a' } },
      },
    });
    fixture.detectChanges();
    const detail = fixture.nativeElement.querySelector('.rl-step-detail') as HTMLElement;
    expect(detail.querySelector('app-call-card')).not.toBeNull();
    expect(detail.textContent).toContain('POST');
    expect(detail.textContent).toContain('200');
    expect(detail.textContent).toContain('Resent from a Live Calls call');
    expect(detail.textContent).toContain('2 changes: 1 header · body');
    expect(detail.textContent).toContain('Request was modified before sending');
  });

  it('search filters blocks by label', () => {
    fixture.componentInstance.onSearch('book');
    fixture.detectChanges();
    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.rl-step');
    expect(rows.length).toBe(2); // "Book" + "Supplier C"
  });
});

describe('T080: SC-009 - a 200-step cycle stays usable', () => {
  /** 40 inbound steps x (1 + 4 children) = 200 steps total. */
  function bigSteps(): Step[] {
    const steps: Step[] = [];
    for (let i = 0; i < 40; i++) {
      const parent = `in-${i}`;
      steps.push(makeStep(parent, null, `Inbound ${i}`));
      for (let c = 0; c < 4; c++) steps.push(makeStep(`${parent}-c${c}`, parent, `Supplier ${i}.${c}`));
    }
    return steps;
  }

  it('renders all 200 steps within budget', () => {
    const steps = bigSteps();
    expect(steps.length).toBe(200);

    const fixture = TestBed.createComponent(ReliveStepTreeComponent);
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('settings', settings);

    const started = performance.now();
    fixture.detectChanges();
    const elapsedMs = performance.now() - started;

    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.rl-step');
    expect(rows.length).toBe(200);
    // Generous budget for a headless CI browser - this is a smoke check against a regression that
    // makes the tree scale badly (e.g. an accidental O(n^2) per-row lookup), not a strict benchmark.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

/** A host like the cycle page: it closes the open step when the tree reports a pick. */
@Component({
  standalone: true,
  imports: [ReliveStepTreeComponent],
  template: `
    <app-relive-step-tree [steps]="steps" [settings]="settings" [selectedKey]="selected()" [detail]="detail" (stepSelect)="picked($event)" />
    <ng-template #detail><textarea class="detail-field">some text</textarea></ng-template>
  `,
})
class TreeHostComponent {
  readonly steps = fixtureSteps();
  readonly settings = settings;
  readonly selected = signal<string | null>('search');
  readonly picks: unknown[] = [];
  picked(key: unknown): void {
    this.picks.push(key);
  }
}

describe('ReliveStepTreeComponent inside a host page', () => {
  it('selecting text in a field of the open step does not close the step (native select event)', () => {
    TestBed.configureTestingModule({
      imports: [TreeHostComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(TreeHostComponent);
    fixture.detectChanges();
    const field: HTMLTextAreaElement = fixture.nativeElement.querySelector('.detail-field');

    // What a double-click on a word does: the browser fires `select`, which bubbles.
    field.dispatchEvent(new Event('select', { bubbles: true }));

    expect(fixture.componentInstance.picks).toEqual([]);
  });
});
