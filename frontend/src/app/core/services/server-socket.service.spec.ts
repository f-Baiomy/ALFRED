import { TestBed } from '@angular/core/testing';
import { AppConfigService } from './app-config.service';
import { ServerSocketEvent, ServerSocketService } from './server-socket.service';

/** Same fake as reconnecting-socket.spec.ts - only the members RxJS's webSocket() touches. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

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

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(): void {
    // the server socket is broadcast-only
  }

  close(): void {
    this.readyState = 3;
  }
}

describe('ServerSocketService', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = (globalThis as Record<string, unknown>)['WebSocket'];
    (globalThis as Record<string, unknown>)['WebSocket'] = FakeWebSocket;
    TestBed.configureTestingModule({ providers: [{ provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test:3000' } }] });
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>)['WebSocket'] = originalWebSocket;
  });

  it('listens on /ws/server and passes each change signal on, without any recurring timer', () => {
    const intervals = spyOn(window, 'setInterval').and.callThrough();
    const service = TestBed.inject(ServerSocketService);
    const events: ServerSocketEvent[] = [];
    const subscription = service.events$.subscribe(e => events.push(e));

    expect(FakeWebSocket.instances.map(s => s.url)).toEqual(['ws://alfred.test:3000/ws/server']);
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].deliver({ type: 'server-status-changed', what: 'settings' });

    expect(events).toEqual([{ type: 'server-status-changed', what: 'settings' }]);
    expect(intervals).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });
});
