import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { CycleWidgetStateService, WidgetArrival, widgetSourceKeyOf } from './cycle-widget-state.service';
import { SessionCyclesStateService } from './session-cycles-state.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { InternalLoggingApiService } from '../services/internal-logging-api.service';
import { CallEndpointSource, CallRecord, CallSummaryDto, SessionCycle } from '../models/call.model';

function cycle(overrides: Partial<SessionCycle>): SessionCycle {
  return { id: 'c1', name: 'Repro', createdAt: '2026-01-01T00:00:00.000Z', assignedTo: null, status: 'PAUSED', ...overrides };
}

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

function dto(id: string, overrides: Partial<CallSummaryDto> = {}): CallSummaryDto {
  return {
    id,
    original_url: `https://host/${id}`,
    url: `https://host/${id}`,
    method: 'GET',
    timestamp: new Date(T0).toISOString(),
    duration_ms: 10,
    status: 200,
    ...overrides,
  };
}

function call(id: string, source: CallEndpointSource, overrides: Partial<CallSummaryDto> = {}, startMs = 0, durationMs = 10): CallRecord {
  return {
    id,
    original_url: `https://host/${id}`,
    url: `https://host/${id}`,
    method: overrides.method ?? 'GET',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 } as CallRecord['response'],
    service_name: overrides.service_name,
    state: overrides.state,
    source,
  };
}

interface Setup {
  state: CycleWidgetStateService;
  cycles: ReturnType<typeof signal<SessionCycle[]>>;
  cyclesState: jasmine.SpyObj<SessionCyclesStateService>;
  api: jasmine.SpyObj<SessionCyclesApiService>;
}

function setup(cycles: SessionCycle[], calls: { external?: CallRecord[]; internal?: CallRecord[] } = {}): Setup {
  const cyclesSignal = signal(cycles);
  const cyclesState = jasmine.createSpyObj<SessionCyclesStateService>(
    'SessionCyclesStateService',
    ['refreshNow', 'create', 'startRecording', 'pauseRecording', 'bulkPauseRecording'],
    { cycles: cyclesSignal }
  );
  const api = jasmine.createSpyObj<SessionCyclesApiService>('SessionCyclesApiService', ['listCalls', 'listSpacers', 'createSpacer', 'renameSpacer', 'deleteSpacer']);
  api.listSpacers.and.returnValue(of([{ id: 's1', label: 'Login done', afterCallId: null, anchorTimestamp: null }]));
  api.createSpacer.and.callFake((_id, label, afterCallId, anchorTimestamp) => of({ id: 'new', label, afterCallId, anchorTimestamp }));
  api.renameSpacer.and.callFake((_id, spacerId, label) => of({ id: spacerId, label }));
  api.deleteSpacer.and.returnValue(of(undefined));
  api.listCalls.and.callFake((_id, _query, source) => {
    const list = (source === 'internal' ? calls.internal : calls.external) ?? [];
    return of({ calls: list.map((c) => ({ id: `cap-${c.id}`, capturedAt: c.timestamp, call: c })), total: list.length });
  });
  const logging = jasmine.createSpyObj<InternalLoggingApiService>('InternalLoggingApiService', ['getFeatureEnabled', 'getServices', 'setEnabled']);
  logging.getFeatureEnabled.and.returnValue(of({ enabled: true }));
  logging.getServices.and.returnValue(of([{ name: 'core-service', listenPort: 8081, upstreamPort: 9081, enabled: true }]));

  TestBed.configureTestingModule({
    providers: [
      { provide: SessionCyclesStateService, useValue: cyclesState },
      { provide: SessionCyclesApiService, useValue: api },
      { provide: InternalLoggingApiService, useValue: logging },
    ],
  });
  return { state: TestBed.inject(CycleWidgetStateService), cycles: cyclesSignal, cyclesState, api };
}

/** activate() would open real sockets - tests drive the load and the socket handler directly instead. */
function load(state: CycleWidgetStateService): void {
  (state as unknown as { active: boolean }).active = true;
  (state as unknown as { load(id: string | null): void }).load(state.selectedCycle()?.id ?? null);
}

function push(state: CycleWidgetStateService, message: unknown, source: CallEndpointSource): void {
  (state as unknown as { onWsMessage(m: unknown, s: CallEndpointSource): void }).onWsMessage(message, source);
}

describe('CycleWidgetStateService', () => {
  beforeEach(() => {
    localStorage.removeItem('alfred-cycle-widget-cycle');
    localStorage.removeItem('alfred-cycle-widget-hidden-sources');
    localStorage.removeItem('alfred_show_options_calls');
    localStorage.removeItem('alfred-cycle-widget-cycle-sort');
    localStorage.removeItem('alfred-cycle-widget-call-order');
  });

  it('sorts the cycle list by the chosen order, and remembers it', () => {
    const a = cycle({ id: 'a', name: 'Zeta', createdAt: '2026-01-01T00:00:00.000Z' });
    const b = cycle({ id: 'b', name: 'alpha', createdAt: '2026-03-01T00:00:00.000Z' });
    const c = cycle({ id: 'c', name: 'Mid', createdAt: '2026-02-01T00:00:00.000Z', status: 'RECORDING' });
    const { state } = setup([a, b, c]);
    const ids = () => state.cycles().map((x) => x.id);

    expect(ids()).toEqual(['b', 'c', 'a']);
    state.setCycleSort('oldest');
    expect(ids()).toEqual(['a', 'c', 'b']);
    state.setCycleSort('recording');
    expect(ids()).toEqual(['c', 'b', 'a']);
    state.setCycleSort('name');
    expect(ids()).toEqual(['b', 'c', 'a']);
    expect(localStorage.getItem('alfred-cycle-widget-cycle-sort')).toBe('name');
  });

  it('reloads its cycle when that cycle is cleared or edited elsewhere, and ignores other cycles', () => {
    const { state, api } = setup([cycle({ id: 'c1' })], { external: [call('a', 'external', {}, 0), call('b', 'external', {}, 1000)] });
    load(state);
    expect(state.calls().length).toBe(2);
    const changed = (id: string) => (state as unknown as { onCycleContentChanged(id: string): void }).onCycleContentChanged(id);

    // "Clear all calls" on the cycle's page (or another window): the backend now holds nothing.
    api.listCalls.and.returnValue(of({ calls: [], total: 0 }));
    api.listSpacers.and.returnValue(of([]));
    changed('another-cycle');
    expect(state.calls().length).toBe(2);
    changed('c1');
    expect(state.calls()).toEqual([]);
    expect(state.spacers()).toEqual([]);
  });

  it('orders the waterfall roots oldest or newest first', () => {
    const { state } = setup([cycle({ id: 'c1' })], { external: [call('first', 'external', {}, 0), call('second', 'external', {}, 5000)] });
    load(state);
    expect(state.tree().map((n) => n.call.id)).toEqual(['first', 'second']);
    state.setCallOrder('newest');
    expect(state.tree().map((n) => n.call.id)).toEqual(['second', 'first']);
  });

  it('loads the cycle\'s spacers with its calls, and adds, renames and deletes them', () => {
    const { state, api } = setup([cycle({ id: 'c1' })], { external: [call('old', 'external', {}, 0), call('latest', 'external', {}, 9000)] });
    load(state);
    expect(state.spacers().map((s) => s.label)).toEqual(['Login done']);

    expect(state.latestAnchor().afterCallId).toBe('latest');
    state.addSpacer('Step 2').subscribe();
    expect(api.createSpacer).toHaveBeenCalledWith('c1', 'Step 2', 'latest', state.calls()[1].timestamp);
    expect(state.spacers().map((s) => s.label)).toEqual(['Login done', 'Step 2']);

    state.renameSpacer('s1', 'Signed in');
    expect(state.spacers()[0].label).toBe('Signed in');
    state.deleteSpacer('new');
    expect(state.spacers().map((s) => s.id)).toEqual(['s1']);
  });

  describe('widgetSourceKeyOf', () => {
    it('files an inbound call under its project, and an unnamed one under "unknown"', () => {
      expect(widgetSourceKeyOf(call('a', 'internal', { service_name: 'core-service' }))).toBe('core-service');
      expect(widgetSourceKeyOf(call('b', 'internal'))).toBe('unknown');
    });

    it('files an outbound call under outbound even when it is attributed to a calling project', () => {
      expect(widgetSourceKeyOf(call('c', 'external', { service_name: 'core-service' }))).toBe('external');
    });
  });

  it('selects the saved cycle, else the recording one, else the newest', () => {
    const older = cycle({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = cycle({ id: 'new', createdAt: '2026-02-01T00:00:00.000Z' });
    const recording = cycle({ id: 'rec', createdAt: '2025-12-01T00:00:00.000Z', status: 'RECORDING' });
    const { state, cycles } = setup([older, newer]);

    expect(state.selectedCycle()?.id).toBe('new');
    cycles.set([older, newer, recording]);
    expect(state.selectedCycle()?.id).toBe('rec');
    state.select('old');
    expect(state.selectedCycle()?.id).toBe('old');
    expect(localStorage.getItem('alfred-cycle-widget-cycle')).toBe('old');
  });

  it('walks cycles newest first and wraps around', () => {
    const a = cycle({ id: 'a', createdAt: '2026-03-01T00:00:00.000Z' });
    const b = cycle({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z' });
    const { state } = setup([b, a]);

    expect(state.selectedCycle()?.id).toBe('a');
    state.selectRelative(1);
    expect(state.selectedCycle()?.id).toBe('b');
    state.selectRelative(1);
    expect(state.selectedCycle()?.id).toBe('a');
    state.selectRelative(-1);
    expect(state.selectedCycle()?.id).toBe('b');
  });

  it('loads outbound and inbound calls of the selected cycle together', () => {
    const { state } = setup([cycle({ id: 'c1' })], {
      external: [call('out', 'external')],
      internal: [call('in', 'internal', { service_name: 'core-service' })],
    });
    load(state);
    expect(state.calls().map((c) => c.id)).toEqual(['out', 'in']);
  });

  it('hides hidden sources and - with Show OPTIONS off, the default - every OPTIONS call, failed or not', () => {
    const failedPreflight = { ...call('refused', 'external', { method: 'OPTIONS', state: 'ERROR' as CallRecord['state'] }), response: undefined };
    const failedPost = { ...call('post', 'external', { method: 'POST', state: 'ERROR' as CallRecord['state'] }), response: undefined };
    const { state } = setup([cycle({ id: 'c1' })], {
      external: [call('out', 'external'), call('pre', 'external', { method: 'OPTIONS' }), failedPreflight, failedPost],
      internal: [call('in', 'internal', { service_name: 'core-service' })],
    });
    (state as unknown as { loadServices(): void }).loadServices();
    load(state);
    expect(state.showOptionsCalls()).toBeFalse();
    expect(state.visibleCalls().map((c) => c.id)).toEqual(['out', 'post', 'in']);
    expect(state.hiddenCounts()).toEqual({ bySource: 0, preflights: 2 });

    state.setShowOptionsCalls(true);
    expect(state.visibleCalls().map((c) => c.id)).toEqual(['out', 'pre', 'refused', 'post', 'in']);
    state.setShowOptionsCalls(false);

    state.toggleSourceVisible('external');
    expect(state.visibleCalls().map((c) => c.id)).toEqual(['in']);

    state.showOnly('external');
    expect(state.visibleCalls().map((c) => c.id)).toEqual(['out', 'post']);
    expect(JSON.parse(localStorage.getItem('alfred-cycle-widget-hidden-sources')!)).toEqual(['core-service']);

    state.showAll();
    expect(state.hiddenSources().size).toBe(0);
  });

  it('re-attaches the children of a hidden call to the nearest visible call around them', () => {
    const { state } = setup([cycle({ id: 'c1' })], {
      internal: [
        call('root', 'internal', { service_name: 'web' }, 0, 1000),
        call('middle', 'internal', { service_name: 'core-service' }, 100, 600),
      ],
      external: [call('leaf', 'external', {}, 200, 100)],
    });
    load(state);
    expect(state.depths().get('leaf')?.depth).toBe(2);
    expect(state.maxDepth()).toBe(2);

    state.toggleSourceVisible('core-service');
    expect(state.depths().get('leaf')?.parentId).toBe('root');
    expect(state.depths().get('leaf')?.depth).toBe(1);
  });

  describe('live calls', () => {
    function collect(state: CycleWidgetStateService): WidgetArrival[] {
      const seen: WidgetArrival[] = [];
      state.arrivals$.subscribe((a) => seen.push(a));
      return seen;
    }

    it('adds a call captured into the selected cycle and announces it once', () => {
      const { state } = setup([cycle({ id: 'c1' })]);
      load(state);
      const seen = collect(state);

      push(state, { call: dto('x', { state: 'IN_PROGRESS', status: null }), capturedByCycleIds: ['c1'] }, 'external');
      expect(state.calls().map((c) => c.id)).toEqual(['x']);

      push(state, { call: dto('x', { state: 'COMPLETE' as CallSummaryDto['state'] }), capturedByCycleIds: ['c1'] }, 'external');
      expect(state.calls().length).toBe(1);
      expect(state.calls()[0].response?.status).toBe(200);
      expect(seen.map((a) => [a.call.id, a.isNew])).toEqual([
        ['x', true],
        ['x', false],
      ]);
    });

    it('hands over every call of a burst, even when they arrive back to back', () => {
      const { state } = setup([cycle({ id: 'c1' })]);
      load(state);
      const seen = collect(state);

      // A parallel fan-out, with one call's resolved push landing between the others.
      push(state, { call: dto('a', { state: 'IN_PROGRESS', status: null }), capturedByCycleIds: ['c1'] }, 'external');
      push(state, { call: dto('b'), capturedByCycleIds: ['c1'] }, 'external');
      push(state, { call: dto('a'), capturedByCycleIds: ['c1'] }, 'external');
      push(state, { call: dto('c'), capturedByCycleIds: ['c1'] }, 'external');

      expect(seen.filter((a) => a.isNew).map((a) => a.call.id)).toEqual(['a', 'b', 'c']);
    });

    it('ignores calls captured into other cycles', () => {
      const { state } = setup([cycle({ id: 'c1' })]);
      load(state);
      const seen = collect(state);
      push(state, { call: dto('x'), capturedByCycleIds: ['other'] }, 'external');
      expect(state.calls()).toEqual([]);
      expect(seen).toEqual([]);
    });

    it('announces OPTIONS only when Show OPTIONS is on', () => {
      const { state } = setup([cycle({ id: 'c1' })]);
      load(state);
      const seen = collect(state);
      push(state, { call: dto('pre', { method: 'OPTIONS', state: 'ERROR' as CallSummaryDto['state'], status: null }), capturedByCycleIds: ['c1'] }, 'internal');
      expect(seen).toEqual([]);
      state.setShowOptionsCalls(true);
      push(state, { call: dto('pre2', { method: 'OPTIONS', state: 'ERROR' as CallSummaryDto['state'], status: null }), capturedByCycleIds: ['c1'] }, 'internal');
      expect(seen.map((a) => a.call.id)).toEqual(['pre2']);
    });

    it('records a call from a hidden source without announcing it', () => {
      const { state } = setup([cycle({ id: 'c1' })]);
      load(state);
      const seen = collect(state);
      state.toggleSourceVisible('core-service');
      push(state, { call: dto('x', { service_name: 'core-service' }), capturedByCycleIds: ['c1'] }, 'internal');
      expect(state.calls().length).toBe(1);
      expect(seen).toEqual([]);
    });
  });

  it('creates a cycle, starts it recording, then pauses whatever else was recording', () => {
    const running = cycle({ id: 'running', status: 'RECORDING' });
    const { state, cyclesState } = setup([running]);
    const created = cycle({ id: 'fresh', name: 'Fresh', createdAt: '2026-09-27T00:00:00.000Z' });
    const order: string[] = [];
    cyclesState.create.and.callFake(() => {
      order.push('create');
      return of(created);
    });
    cyclesState.startRecording.and.callFake(() => {
      order.push('start');
      return of({ ...created, status: 'RECORDING' });
    });
    cyclesState.bulkPauseRecording.and.callFake((ids) => {
      order.push(`pause:${ids.join(',')}`);
      return of([]);
    });

    let result: SessionCycle | undefined;
    state.createAndRecord('Fresh').subscribe((c) => (result = c));

    expect(order).toEqual(['create', 'start', 'pause:running']);
    expect(cyclesState.create).toHaveBeenCalledWith({ name: 'Fresh' });
    expect(result?.id).toBe('fresh');
    expect(localStorage.getItem('alfred-cycle-widget-cycle')).toBe('fresh');
  });

  it('builds outbound plus one inbound source per project, with each project\'s logging switch', () => {
    const { state } = setup([cycle({ id: 'c1' })]);
    (state as unknown as { loadServices(): void }).loadServices();
    expect(state.sources()).toEqual([
      { key: 'external', label: 'Outbound', direction: 'outbound', loggingEnabled: null },
      { key: 'core-service', label: 'core-service', direction: 'inbound', loggingEnabled: true },
    ]);
  });
});
