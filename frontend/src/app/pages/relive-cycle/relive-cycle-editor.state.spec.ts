import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { defaultCallRule, modeOf } from '../../shared/utils/relive-call-rule';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';
import { CycleRule, FrozenCall, GlobalRulesSelection, ReliveCycle, ReliveSettings, Step, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';

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

function makeStep(key: string, parentKey: string | null): Step {
  return {
    key,
    parentKey,
    label: parentKey ? 'Supplier A' : 'Search',
    enabled: true,
    optional: false,
    direction: parentKey ? 'outbound' : 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey, label: 'x', recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: key, cycleId: null, direction: parentKey ? 'outbound' : 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function editedRule(rule: CycleRule): CycleRule {
  return { ...rule, actions: rule.actions.map((a) => (a.type === 'MOCK_RESPONSE' ? { ...a, body: '{"edited":true}' } : a)) };
}

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' };

function cycle(overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps: [],
    variables: [],
    cycleRules: [],
    globalRules,
    settings,
    noise: [],
    unexpectedCalls,
    createdAt: '2026-09-27T10:00:00Z',
    updatedAt: '2026-09-27T10:00:00Z',
    transient: false,
    lastRun: null,
    ...overrides,
  };
}

describe('ReliveCycleEditorState', () => {
  let state: ReliveCycleEditorState;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ReliveCycleEditorState,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    state = TestBed.inject(ReliveCycleEditorState);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('is not dirty right after loading', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());
    expect(state.dirty()).toBeFalse();
  });

  it('becomes dirty once the draft changes, and clean again once it matches saved again', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());

    state.update((d) => ({ ...d, name: 'Renamed' }));
    expect(state.dirty()).toBeTrue();

    state.update((d) => ({ ...d, name: 'Book flow' }));
    expect(state.dirty()).toBeFalse();
  });

  it('save() sends If-Match and clears dirty on success', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());
    state.update((d) => ({ ...d, name: 'Renamed' }));

    state.save();
    const req = http.expectOne('http://backend/relive-cycles/c-1');
    expect(req.request.headers.get('If-Match')).toBe('2026-09-27T10:00:00Z');
    req.flush(cycle({ name: 'Renamed', updatedAt: '2026-09-27T11:00:00Z' }));

    expect(state.dirty()).toBeFalse();
    expect(state.saved()?.name).toBe('Renamed');
  });

  it('a 409 on save sets `conflict` to the server\'s current definition, showing the reload prompt', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());
    state.update((d) => ({ ...d, name: 'Renamed locally' }));

    state.save();
    http.expectOne('http://backend/relive-cycles/c-1').flush('conflict', { status: 409, statusText: 'Conflict' });

    // Reading the conflict re-fetches the cycle's real current state.
    const refetch = http.expectOne('http://backend/relive-cycles/c-1');
    refetch.flush(cycle({ name: 'Renamed by someone else', updatedAt: '2026-09-27T12:00:00Z' }));

    expect(state.conflict()).not.toBeNull();
    expect(state.conflict()?.name).toBe('Renamed by someone else');
    // The local draft is left alone until the user decides.
    expect(state.draft()?.name).toBe('Renamed locally');
  });

  it('reloadFromConflict() replaces the draft with the server version and clears the conflict', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());
    state.update((d) => ({ ...d, name: 'Renamed locally' }));

    state.save();
    http.expectOne('http://backend/relive-cycles/c-1').flush('conflict', { status: 409, statusText: 'Conflict' });
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle({ name: 'Renamed by someone else', updatedAt: '2026-09-27T12:00:00Z' }));

    state.reloadFromConflict();

    expect(state.conflict()).toBeNull();
    expect(state.draft()?.name).toBe('Renamed by someone else');
    expect(state.dirty()).toBeFalse();
  });

  it('resetStep() rebuilds only that step\'s call rule from the recording', () => {
    const child = makeStep('c-supA', 's-search');
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle({ steps: [makeStep('s-search', null), { ...child, callRule: editedRule(child.callRule), unattributed: 'SEND_REAL' }] }));

    state.resetStep('c-supA');

    const reset = state.draft()!.steps.find((s) => s.key === 'c-supA')!;
    expect(reset.unattributed).toBe('BLOCK');
    expect(reset.callRule.actions.find((a) => a.type === 'MOCK_RESPONSE')?.body).toBe(recording.responseBody);
  });

  it('resetCycle() rebuilds every step\'s call rule and re-enables every step', () => {
    const child = makeStep('c-supA', 's-search');
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(
      cycle({ steps: [{ ...makeStep('s-search', null), enabled: false }, { ...child, callRule: editedRule(child.callRule), enabled: false }] }),
    );

    state.resetCycle();

    const steps = state.draft()!.steps;
    expect(steps.every((s) => s.enabled)).toBeTrue();
    const resetChild = steps.find((s) => s.key === 'c-supA')!;
    expect(modeOf(resetChild.callRule)).toBe('REPLAY');
    expect(resetChild.callRule.actions.find((a) => a.type === 'MOCK_RESPONSE')?.body).toBe(recording.responseBody);
  });

  it('duplicateStep() gives the step and its children fresh keys, right after the original block', () => {
    const search = makeStep('s-search', null);
    const supA = makeStep('c-supA', 's-search');
    const book = makeStep('s-book', null);
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle({ steps: [search, supA, book] }));

    state.duplicateStep('s-search');

    const keys = state.draft()!.steps.map((s) => s.key);
    expect(keys).toEqual(['s-search', 'c-supA', jasmine.any(String), jasmine.any(String), 's-book']);
    const copy = state.draft()!.steps[2];
    expect(copy.label).toBe('Search (2)');
    const childCopy = state.draft()!.steps[3];
    expect(childCopy.parentKey).toBe(copy.key);
  });

  it('duplicateCycle() calls the API duplicate endpoint for the saved cycle', () => {
    state.load('c-1');
    http.expectOne('http://backend/relive-cycles/c-1').flush(cycle());

    state.duplicateCycle()?.subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1/duplicate');
    expect(req.request.method).toBe('POST');
    req.flush(cycle({ id: 'c-2', name: 'Book flow (copy)' }));
  });
});
