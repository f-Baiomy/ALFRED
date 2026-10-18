import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionsStateService } from './sessions-state.service';
import { readKey, saveKey } from '../services/alfred-key';

describe('SessionsStateService (specs/031)', () => {
  let state: SessionsStateService;
  let http: HttpTestingController;
  const NOBODY = { user: null, machine: null, kind: null, keyId: null, helperKeyId: null, admin: false };

  beforeEach(() => {
    saveKey(null);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    state = TestBed.inject(SessionsStateService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.match(() => true);
    saveKey(null);
  });

  it('an answer to a request sent before pairing neither drops the new key nor says the browser is unpaired', () => {
    state.loadMe(); // sent with no key (the page opened before pairing)
    const early = http.expectOne((r) => r.url.endsWith('/board/me'));

    saveKey('ak_0123456789abcdef.new'); // pairing (or Connect this PC) finished meanwhile
    state.me.set({ ...NOBODY, user: 'me@x.ae', keyId: 'b1', helperKeyId: 'h1', kind: 'BROWSER', machine: 'PC' });
    early.flush(NOBODY);

    expect(readKey()).toBe('ak_0123456789abcdef.new');
    expect(state.me()?.user).toBe('me@x.ae');
  });

  it('a key Alfred no longer knows is dropped', () => {
    saveKey('ak_0123456789abcdef.revoked');
    state.loadMe();
    http.expectOne((r) => r.url.endsWith('/board/me')).flush(NOBODY);

    expect(readKey()).toBeNull();
    expect(state.paired()).toBeFalse();
  });
});
