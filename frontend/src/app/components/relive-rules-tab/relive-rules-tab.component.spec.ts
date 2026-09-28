import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionRule } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { defaultCallRule, isModified, modeOf } from '../../shared/utils/relive-call-rule';
import { FrozenCall, GlobalRulesSelection, ReliveCycle, ReliveSettings, Step, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';
import { ReliveRulesTabComponent } from './relive-rules-tab.component';

function globalRule(overrides: Partial<InterceptionRule> = {}): InterceptionRule {
  return { id: 'g-1', name: 'Currency → AED', enabled: true, priority: 0, stopProcessing: true, match: {}, actions: [], ...overrides };
}

const recording: FrozenCall = {
  method: 'GET',
  url: 'https://app.local/search',
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
  source: 'inbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' };

function inboundStep(key: string): Step {
  return {
    key,
    parentKey: null,
    label: 'Search',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey: null, label: 'Search', recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: key, cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function cycle(overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps: [inboundStep('s-search')],
    variables: [],
    cycleRules: [],
    globalRules,
    settings,
    noise: [],
    unexpectedCalls,
    createdAt: null,
    updatedAt: null,
    transient: false,
    lastRun: null,
    ...overrides,
  };
}

describe('ReliveRulesTabComponent', () => {
  let fixture: ComponentFixture<ReliveRulesTabComponent>;
  const globalRulesSignal = signal<InterceptionRule[]>([]);

  beforeEach(() => {
    globalRulesSignal.set([]);
    TestBed.configureTestingModule({
      imports: [ReliveRulesTabComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: InterceptionStateService, useValue: { rules: globalRulesSignal } },
      ],
    });
    fixture = TestBed.createComponent(ReliveRulesTabComponent);
  });

  it('switching the inbound mode applies applyMode to every inbound step and emits the updated cycle', async () => {
    fixture.componentRef.setInput('cycle', cycle());
    let emitted: ReliveCycle | null = null;
    fixture.componentInstance.cycleChange.subscribe((c: ReliveCycle) => (emitted = c));

    await fixture.componentInstance.setInboundMode('REPLAY');

    expect(emitted!.settings.inboundMode).toBe('REPLAY');
    expect(modeOf(emitted!.steps[0].callRule)).toBe('REPLAY');
  });

  it('asks for confirmation when a hand-edited inbound step would be overwritten', async () => {
    const step = inboundStep('s-search');
    const edited = { ...step, callRule: { ...step.callRule, actions: [...step.callRule.actions, { type: 'SET_REQUEST_HEADER' as const, name: 'X', value: 'y', enabled: true }] } };
    fixture.componentRef.setInput('cycle', cycle({ steps: [edited] }));
    expect(isModified(edited.callRule, edited, settings)).toBeTrue();

    const confirmDialog = TestBed.inject(ConfirmDialogService);
    const confirmSpy = spyOn(confirmDialog, 'confirm').and.returnValue(Promise.resolve(false));

    let emitted: ReliveCycle | null = null;
    fixture.componentInstance.cycleChange.subscribe((c: ReliveCycle) => (emitted = c));
    await fixture.componentInstance.setInboundMode('REPLAY');

    expect(confirmSpy).toHaveBeenCalled();
    expect(emitted).toBeNull();
  });

  it('changing the unexpected-call policy emits the updated cycle', () => {
    fixture.componentRef.setInput('cycle', cycle());
    let emitted: ReliveCycle | null = null;
    fixture.componentInstance.cycleChange.subscribe((c: ReliveCycle) => (emitted = c));

    fixture.componentInstance.setUnexpectedPolicy('SEND_REAL');

    expect(emitted!.unexpectedCalls.policy).toBe('SEND_REAL');
  });

  describe('T067: global rules', () => {
    it('copying a global rule creates an independent CYCLE-tier rule, tagged with copiedFrom', () => {
      globalRulesSignal.set([globalRule()]);
      fixture.componentRef.setInput('cycle', cycle());
      fixture.detectChanges();

      let emitted: ReliveCycle | null = null;
      fixture.componentInstance.cycleChange.subscribe((c: ReliveCycle) => (emitted = c));
      fixture.componentInstance.copyGlobalRuleIntoCycle(globalRulesSignal()[0]);

      expect(emitted!.cycleRules.length).toBe(1);
      const copy = emitted!.cycleRules[0];
      expect(copy.name).toBe('Currency → AED');
      expect(copy.copiedFrom).toEqual(jasmine.objectContaining({ ruleId: 'g-1', name: 'Currency → AED' }));

      // Editing the copy must never touch the original global rule.
      const editedCopy = { ...copy, name: 'Currency → AED (cycle copy)' };
      expect(globalRulesSignal()[0].name).toBe('Currency → AED');
      expect(editedCopy.name).not.toBe(globalRulesSignal()[0].name);
    });

    it('globalRuleApplies reflects NONE/ALL/SELECTED', () => {
      const rule = globalRule();
      globalRulesSignal.set([rule]);
      fixture.componentRef.setInput('cycle', cycle({ globalRules: { mode: 'NONE', selectedIds: [] } }));
      fixture.detectChanges();
      expect(fixture.componentInstance.globalRuleApplies(rule)).toBeFalse();

      fixture.componentRef.setInput('cycle', cycle({ globalRules: { mode: 'ALL', selectedIds: [] } }));
      fixture.detectChanges();
      expect(fixture.componentInstance.globalRuleApplies(rule)).toBeTrue();

      fixture.componentRef.setInput('cycle', cycle({ globalRules: { mode: 'SELECTED', selectedIds: ['g-1'] } }));
      fixture.detectChanges();
      expect(fixture.componentInstance.globalRuleApplies(rule)).toBeTrue();

      fixture.componentRef.setInput('cycle', cycle({ globalRules: { mode: 'SELECTED', selectedIds: [] } }));
      fixture.detectChanges();
      expect(fixture.componentInstance.globalRuleApplies(rule)).toBeFalse();
    });

    it('toggleSelectedGlobalRule adds and removes the id', () => {
      fixture.componentRef.setInput('cycle', cycle({ globalRules: { mode: 'SELECTED', selectedIds: [] } }));
      fixture.detectChanges();
      let emitted: ReliveCycle | null = null;
      fixture.componentInstance.cycleChange.subscribe((c: ReliveCycle) => (emitted = c));

      fixture.componentInstance.toggleSelectedGlobalRule('g-1');
      expect(emitted!.globalRules.selectedIds).toEqual(['g-1']);

      fixture.componentRef.setInput('cycle', emitted!);
      fixture.componentInstance.toggleSelectedGlobalRule('g-1');
      expect(emitted!.globalRules.selectedIds).toEqual([]);
    });
  });
});
