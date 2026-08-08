import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of } from 'rxjs';
import { SessionCyclesStateService } from './session-cycles-state.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { SessionCycle } from '../models/call.model';

function makeCycle(overrides: Partial<SessionCycle> = {}): SessionCycle {
  return {
    id: 'c1',
    name: 'Repro',
    createdAt: '2026-01-01T00:00:00.000Z',
    assignedTo: null,
    status: 'PAUSED',
    ...overrides,
  };
}

/**
 * Injects a SessionCyclesStateService whose polling resolves immediately to `cycles`, with the
 * mutation methods stubbed to echo their input back. Same fakeAsync/tick/discardPeriodicTasks
 * contract as CallsStateService's spec, since this service polls on the same kind of timer.
 */
function setup(cycles: SessionCycle[]): SessionCyclesStateService {
  const apiStub: Partial<SessionCyclesApiService> = {
    list: () => of(cycles),
    update: (id, request) => of({ ...cycles.find((c) => c.id === id)!, ...request } as SessionCycle),
    startRecording: (id) => of({ ...cycles.find((c) => c.id === id)!, status: 'RECORDING' } as SessionCycle),
    pauseRecording: (id) => of({ ...cycles.find((c) => c.id === id)!, status: 'PAUSED' } as SessionCycle),
    delete: () => of(undefined),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SessionCyclesApiService, useValue: apiStub }],
  });
  return TestBed.inject(SessionCyclesStateService);
}

describe('SessionCyclesStateService', () => {
  it('filters by name or assignedTo, case-insensitively', fakeAsync(() => {
    const a = makeCycle({ id: 'a', name: 'Flight booking', assignedTo: null });
    const b = makeCycle({ id: 'b', name: 'Hotel search', assignedTo: 'profile-42' });
    const state = setup([a, b]);
    tick();

    state.setSearchQuery('flight');
    expect(state.matchingCycles()).toEqual([a]);

    state.setSearchQuery('PROFILE-42');
    expect(state.matchingCycles()).toEqual([b]);

    discardPeriodicTasks();
  }));

  it('sorts newest first by default', fakeAsync(() => {
    const older = makeCycle({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeCycle({ id: 'newer', createdAt: '2026-01-02T00:00:00.000Z' });
    const state = setup([older, newer]);
    tick();

    expect(state.sortedCycles().map((c) => c.id)).toEqual(['newer', 'older']);
    discardPeriodicTasks();
  }));

  it('sorts oldest first when requested', fakeAsync(() => {
    const older = makeCycle({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeCycle({ id: 'newer', createdAt: '2026-01-02T00:00:00.000Z' });
    const state = setup([older, newer]);
    tick();

    state.setSortMode('oldest');

    expect(state.sortedCycles().map((c) => c.id)).toEqual(['older', 'newer']);
    discardPeriodicTasks();
  }));

  it('sorts recording cycles first when sorting by status', fakeAsync(() => {
    const paused = makeCycle({ id: 'paused', status: 'PAUSED', createdAt: '2026-01-02T00:00:00.000Z' });
    const recording = makeCycle({ id: 'recording', status: 'RECORDING', createdAt: '2026-01-01T00:00:00.000Z' });
    const state = setup([paused, recording]);
    tick();

    state.setSortMode('status');

    expect(state.sortedCycles().map((c) => c.id)).toEqual(['recording', 'paused']);
    discardPeriodicTasks();
  }));

  it('paginates and grows on loadMore', fakeAsync(() => {
    const cycles = Array.from({ length: 15 }, (_, i) => makeCycle({ id: `c${i}`, createdAt: `2026-01-${10 + i}T00:00:00.000Z` }));
    const state = setup(cycles);
    tick();

    expect(state.visibleCycles().length).toBe(10);
    expect(state.remainingCount()).toBe(5);

    state.loadMore();

    expect(state.visibleCycles().length).toBe(15);
    expect(state.remainingCount()).toBe(0);
    discardPeriodicTasks();
  }));

  it('tracks a selection independent of sort/filter', fakeAsync(() => {
    const a = makeCycle({ id: 'a' });
    const b = makeCycle({ id: 'b' });
    const state = setup([a, b]);
    tick();

    state.toggleSelected(a);
    expect(state.isSelected(a)).toBe(true);
    expect(state.selectedCycles()).toEqual([a]);

    state.selectAll();
    expect(state.selectedCycles().length).toBe(2);

    state.clearSelection();
    expect(state.selectedCycles()).toEqual([]);
    discardPeriodicTasks();
  }));

  it('bulkDelete skips recording cycles and deletes the rest', fakeAsync(() => {
    const recording = makeCycle({ id: 'recording', status: 'RECORDING' });
    const paused = makeCycle({ id: 'paused', status: 'PAUSED' });
    const state = setup([recording, paused]);
    tick();

    let result: { deleted: number; skippedRecording: number } | undefined;
    state.bulkDelete(['recording', 'paused']).subscribe((r) => (result = r));
    tick();

    expect(result).toEqual({ deleted: 1, skippedRecording: 1 });
    discardPeriodicTasks();
  }));

  it('bulkReassign applies one assignedTo value to every given id', fakeAsync(() => {
    const a = makeCycle({ id: 'a', assignedTo: 'old' });
    const b = makeCycle({ id: 'b', assignedTo: null });
    const state = setup([a, b]);
    tick();

    let results: SessionCycle[] = [];
    state.bulkReassign(['a', 'b'], 'new-profile').subscribe((r) => (results = r));
    tick();

    expect(results.map((c) => c.assignedTo)).toEqual(['new-profile', 'new-profile']);
    discardPeriodicTasks();
  }));

  it('bulkStartRecording and bulkPauseRecording apply to every given id', fakeAsync(() => {
    const a = makeCycle({ id: 'a', status: 'PAUSED' });
    const b = makeCycle({ id: 'b', status: 'PAUSED' });
    const state = setup([a, b]);
    tick();

    let recorded: SessionCycle[] = [];
    state.bulkStartRecording(['a', 'b']).subscribe((r) => (recorded = r));
    tick();
    expect(recorded.every((c) => c.status === 'RECORDING')).toBe(true);

    let paused: SessionCycle[] = [];
    state.bulkPauseRecording(['a', 'b']).subscribe((r) => (paused = r));
    tick();
    expect(paused.every((c) => c.status === 'PAUSED')).toBe(true);

    discardPeriodicTasks();
  }));
});
