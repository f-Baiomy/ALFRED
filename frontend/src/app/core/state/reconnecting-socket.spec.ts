import { fakeAsync, tick } from '@angular/core/testing';
import { Subscription } from 'rxjs';
import { reconnectingSocket } from './reconnecting-socket';

/**
 * Stands in for the browser's WebSocket so a close can be provoked on demand - the whole point of
 * these tests is which KIND of close happened, and a real socket against a real backend can't be
 * asked to close cleanly on cue. Only the members RxJS's webSocket() actually touches are here.
 */
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

  /** What a graceful backend shutdown or redeploy sends: a real close frame, code 1000. */
  closeCleanly(): void {
    this.readyState = 3;
    this.onclose?.({ wasClean: true, code: 1000 });
  }

  /** What a crash or a dropped network looks like: no close frame at all, code 1006. */
  closeAbnormally(): void {
    this.readyState = 3;
    this.onclose?.({ wasClean: false, code: 1006 });
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

describe('reconnectingSocket', () => {
  let originalWebSocket: unknown;
  let subscription: Subscription;

  beforeEach(() => {
    originalWebSocket = (window as unknown as { WebSocket: unknown }).WebSocket;
    FakeWebSocket.instances = [];
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    subscription?.unsubscribe();
    (window as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  function latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  it('opens one socket on subscribe', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(latest().url).toBe('ws://test/ws/calls');
  }));

  it('reconnects after a CLEAN close - the one retry() alone never recovered from', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();
    latest().open();

    // A graceful backend restart. RxJS turns this into a completion, not an error, which is
    // exactly what retry() ignores - the dashboard used to go silently deaf right here.
    latest().closeCleanly();
    tick(3000);

    expect(FakeWebSocket.instances.length).toBe(2);
  }));

  it('reconnects after an abnormal close too', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();
    latest().open();

    latest().closeAbnormally();
    tick(3000);

    expect(FakeWebSocket.instances.length).toBe(2);
  }));

  it('keeps reconnecting for as long as the backend stays away', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();
    latest().open();

    latest().closeCleanly();
    tick(3000);
    latest().closeCleanly();
    tick(3000);
    latest().closeAbnormally();
    tick(3000);

    expect(FakeWebSocket.instances.length).toBe(4);
  }));

  it('waits the reconnect delay rather than hammering the backend', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();
    latest().open();

    latest().closeCleanly();
    tick(2999);
    expect(FakeWebSocket.instances.length).toBe(1);

    tick(1);
    expect(FakeWebSocket.instances.length).toBe(2);
  }));

  it('tells the caller it reconnected - but never on the first connection', fakeAsync(() => {
    const onReconnect = jasmine.createSpy('onReconnect');
    subscription = reconnectingSocket('ws://test/ws/calls', onReconnect).subscribe();

    // The caller already fetches once on construction; firing here would just double it.
    latest().open();
    expect(onReconnect).not.toHaveBeenCalled();

    latest().closeCleanly();
    tick(3000);
    latest().open();

    expect(onReconnect).toHaveBeenCalledTimes(1);
  }));

  it('still delivers messages after reconnecting', fakeAsync(() => {
    const received: unknown[] = [];
    subscription = reconnectingSocket<{ id: string }>('ws://test/ws/calls').subscribe((m) => received.push(m));
    latest().open();
    latest().deliver({ id: 'before' });

    latest().closeCleanly();
    tick(3000);
    latest().open();
    latest().deliver({ id: 'after' });

    expect(received).toEqual([{ id: 'before' }, { id: 'after' }]);
  }));

  it('stops reconnecting once the subscriber goes away', fakeAsync(() => {
    subscription = reconnectingSocket('ws://test/ws/calls').subscribe();
    latest().open();

    subscription.unsubscribe();
    latest().closeCleanly();
    tick(3000);

    expect(FakeWebSocket.instances.length).toBe(1);
  }));
});
