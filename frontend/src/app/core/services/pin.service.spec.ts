import { TestBed } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { callKey } from '../../shared/utils/call-utils';
import { PinService } from './pin.service';

const STORAGE_KEY = 'alfred_pinned_calls';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    request: { headers: {}, body: '' },
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    ...overrides,
  };
}

describe('PinService', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('starts with nothing pinned when storage is empty', () => {
    const service = TestBed.inject(PinService);
    expect(service.pinned().size).toBe(0);
  });

  it('pins a call and reports it as pinned', () => {
    const service = TestBed.inject(PinService);
    const call = makeCall();

    service.toggle(call);

    expect(service.isPinned(call)).toBe(true);
    expect(service.pinned().size).toBe(1);
  });

  it('unpins on a second toggle', () => {
    const service = TestBed.inject(PinService);
    const call = makeCall();

    service.toggle(call);
    service.toggle(call);

    expect(service.isPinned(call)).toBe(false);
    expect(service.pinned().size).toBe(0);
  });

  it('persists pins to localStorage so a fresh instance picks them up', () => {
    const first = TestBed.inject(PinService);
    const call = makeCall();
    first.toggle(call);

    // Simulate a page reload: a brand new injector, same localStorage.
    TestBed.resetTestingModule();
    const second = TestBed.inject(PinService);

    expect(second.isPinned(call)).toBe(true);
  });

  it('caches the full call, not just its id, so it survives dropping out of the backend window', () => {
    const service = TestBed.inject(PinService);
    const call = makeCall({ request: { headers: { 'x-custom': 'value' }, body: 'payload' } });
    service.toggle(call);

    const stored = [...service.pinned().values()][0];
    expect(stored.request!.body).toBe('payload');
    expect(callKey(stored)).toBe(callKey(call));
  });
});
