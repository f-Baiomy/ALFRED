import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { alfredKeyInterceptor, readKey, saveKey, sameAlfred } from './alfred-key';

describe('alfredKeyInterceptor (specs/031 board lock)', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([alfredKeyInterceptor])), provideHttpClientTesting()] });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    saveKey(null);
    ctrl.verify();
  });

  it('sends a paired browser\'s key to Alfred only', () => {
    saveKey('ak_0123456789abcdef.secret');
    const backend = window.BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:5000`;
    http.get(`${backend}/board/cards`).subscribe();
    http.get('https://dev.azure.com/x').subscribe();
    expect(ctrl.expectOne(`${backend}/board/cards`).request.headers.get('X-Alfred-Key')).toBe('ak_0123456789abcdef.secret');
    expect(ctrl.expectOne('https://dev.azure.com/x').request.headers.has('X-Alfred-Key')).toBeFalse();
  });

  it('sends nothing from an unpaired browser', () => {
    saveKey(null);
    http.get('/board/cards').subscribe();
    expect(ctrl.expectOne('/board/cards').request.headers.has('X-Alfred-Key')).toBeFalse();
    expect(readKey()).toBeNull();
  });

  it('knows Alfred by its origin', () => {
    expect(sameAlfred('/board/me', 'http://a:3000')).toBeTrue();
    expect(sameAlfred('//evil/x', 'http://a:3000')).toBeFalse();
    expect(sameAlfred('http://a:3000/board', 'http://a:3000')).toBeTrue();
    expect(sameAlfred('http://b:3000/board', 'http://a:3000')).toBeFalse();
  });
});
