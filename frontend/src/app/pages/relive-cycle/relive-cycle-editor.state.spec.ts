import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';
import { GlobalRulesSelection, ReliveCycle, ReliveSettings, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';

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
});
