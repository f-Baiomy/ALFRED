import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AppConfigService } from './app-config.service';
import { ReliveSocketService } from './relive-socket.service';

/** Same fake as reconnecting-socket.spec.ts - only the members RxJS's webSocket() touches. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: unknown[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
  }

  closeCleanly(): void {
    this.readyState = 3;
    this.onclose?.({ wasClean: true, code: 1000 });
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }
}

describe('ReliveSocketService', () => {
  let originalWebSocket: unknown;
  let service: ReliveSocketService;

  beforeEach(() => {
    originalWebSocket = (window as unknown as { WebSocket: unknown }).WebSocket;
    FakeWebSocket.instances = [];
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

    TestBed.configureTestingModule({
      providers: [{ provide: AppConfigService, useValue: { backendUrl: 'http://backend' } }],
    });
    service = TestBed.inject(ReliveSocketService);
  });

  afterEach(() => {
    (window as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  function latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  it('connects to /ws/relive over ws://', () => {
    expect(latest().url).toBe('ws://backend/ws/relive');
  });

  it('sends a lease message when held, after the socket is open', fakeAsync(() => {
    latest().open();
    service.holdLease('r-1');
    expect(latest().sent).toContain({ type: 'lease', runId: 'r-1' });
  }));

  it('tells the backend when a lease is released, once', fakeAsync(() => {
    latest().open();
    service.holdLease('r-1');
    service.releaseLease('r-1');
    service.releaseLease('r-1');
    expect(latest().sent.filter((m) => (m as { type: string }).type === 'release')).toEqual([{ type: 'release', runId: 'r-1' }]);
  }));

  it('re-sends every held lease after a reconnect', fakeAsync(() => {
    latest().open();
    service.holdLease('r-1');
    service.holdLease('r-2');

    latest().closeCleanly();
    tick(3000);
    latest().open();

    const runIdsSent = latest().sent.map((m) => (m as { runId: string }).runId);
    expect(runIdsSent).toContain('r-1');
    expect(runIdsSent).toContain('r-2');
  }));

  it('does not re-send a released lease', fakeAsync(() => {
    latest().open();
    service.holdLease('r-1');
    service.releaseLease('r-1');

    latest().closeCleanly();
    tick(3000);
    latest().open();

    expect(latest().sent).toEqual([]);
  }));

  it('forwards run events but never the lease echo', fakeAsync(() => {
    const received: unknown[] = [];
    service.events$.subscribe((e) => received.push(e));
    latest().open();

    latest().deliver({ type: 'relive-changed' });
    latest().deliver({ type: 'lease', runId: 'r-1' });

    expect(received).toEqual([{ type: 'relive-changed' }]);
  }));
});
