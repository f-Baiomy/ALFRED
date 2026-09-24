import { TestBed } from '@angular/core/testing';
import { EditTabService, editTabChannelName, editTabStorageKey } from './edit-tab.service';

/** Stands in for BroadcastChannel, delivering to every other instance on the same name. */
class FakeChannel {
  static all: FakeChannel[] = [];
  readonly listeners: ((event: MessageEvent) => void)[] = [];
  closed = false;

  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }

  addEventListener(_: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.push(listener);
  }

  postMessage(data: unknown): void {
    for (const other of FakeChannel.all) {
      if (other !== this && other.name === this.name && !other.closed) {
        other.listeners.forEach((l) => l({ data } as MessageEvent));
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe('EditTabService', () => {
  let service: EditTabService;
  let realChannel: typeof BroadcastChannel;

  beforeEach(() => {
    FakeChannel.all = [];
    realChannel = window.BroadcastChannel;
    (window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = FakeChannel;
    TestBed.configureTestingModule({});
    service = TestBed.inject(EditTabService);
  });

  afterEach(() => {
    (window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = realChannel;
    sessionStorage.removeItem(editTabStorageKey('k1'));
  });

  it('seeds sessionStorage and opens /edit with the key', () => {
    const open = spyOn(window, 'open');

    service.open('k1', { kind: 'body', title: 'Response body', value: '{"a":1}' });

    expect(JSON.parse(sessionStorage.getItem('alfred_edit_tab_k1')!)).toEqual({
      kind: 'body',
      title: 'Response body',
      value: '{"a":1}',
    });
    expect(open).toHaveBeenCalledWith('/edit?key=k1', '_blank');
  });

  it('encodes a key that is not URL-safe', () => {
    const open = spyOn(window, 'open');
    service.open('call 1/response', { kind: 'body', title: '', value: '' });

    expect(open).toHaveBeenCalledWith('/edit?key=call%201%2Fresponse', '_blank');
    sessionStorage.removeItem(editTabStorageKey('call 1/response'));
  });

  it('reads the seed back, and null once it is gone or mangled', () => {
    service.store('k1', { kind: 'headers', title: 'Headers', value: '[]' });
    expect(service.readSeed('k1')).toEqual({ kind: 'headers', title: 'Headers', value: '[]' });

    sessionStorage.setItem(editTabStorageKey('k1'), '{not json');
    expect(service.readSeed('k1')).toBeNull();

    expect(service.readSeed('never-opened')).toBeNull();
  });

  it('delivers values with a plain callback', () => {
    const values: string[] = [];
    service.listen('k1', (v) => values.push(v));

    service.publisher('k1').post({ type: 'value', value: 'edited' });

    expect(FakeChannel.all[0].name).toBe(editTabChannelName('k1'));
    expect(values).toEqual(['edited']);
  });

  it('delivers values and closed with handler objects, and stops after unsubscribe', () => {
    const values: string[] = [];
    let closed = 0;
    const stop = service.listen('k1', { value: (v) => values.push(v), closed: () => closed++ });
    const publisher = service.publisher('k1');

    publisher.post({ type: 'value', value: 'one' });
    publisher.post({ type: 'closed' });
    stop();
    publisher.post({ type: 'value', value: 'two' });

    expect(values).toEqual(['one']);
    expect(closed).toBe(1);
  });

  it('ignores messages for a different key', () => {
    const values: string[] = [];
    service.listen('k1', (v) => values.push(v));

    service.publisher('k2').post({ type: 'value', value: 'not mine' });

    expect(values).toEqual([]);
  });
});
