import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../models/board.models';
import { AppConfigService } from './app-config.service';
import { BoardSocketService } from './board-socket.service';
import { SnippetDataService } from './snippet-data.service';

/** specs/017 R17: a snippet names a source, never a URL - and only Alfred's own GET endpoints answer. */
describe('SnippetDataService', () => {
  let http: HttpTestingController;
  let data: SnippetDataService;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test' } },
        { provide: BoardSocketService, useValue: { events$: new Subject<BoardSocketEvent>() } }],
    });
    http = TestBed.inject(HttpTestingController);
    data = TestBed.inject(SnippetDataService);
  });

  afterEach(() => http.verify());

  it('refuses anything but a known source', async () => {
    await expectAsync(data.read('http://evil.example/x', {})).toBeRejectedWithError(/is not a source/);
    await expectAsync(data.read('../settings', {})).toBeRejectedWithError(/is not a source/);
    await expectAsync(data.read('call', {})).toBeRejectedWithError(/Name the call/);
  });

  it('reads calls with the text\'s project, an endpoint, a relative since, and a capped limit', async () => {
    const before = Date.now();
    const got = data.read('calls', { endpoint: 'POST /fare', since: '2h', limit: 99999, signal: '5xx' }, { project: 'odeysys' });
    await flush();
    const req = http.expectOne((r) => r.url === 'http://alfred.test/board/data/calls');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('project')).toBe('odeysys');
    expect(req.request.params.get('endpoint')).toBe('POST /fare');
    expect(req.request.params.get('signal')).toBe('5xx');
    expect(req.request.params.get('limit')).toBe('1000');
    const since = Date.parse(req.request.params.get('since')!);
    expect(before - since).toBeGreaterThanOrEqual(2 * 3600e3 - 1000);
    req.flush({ calls: [{ ref: 'in:a' }], truncated: false });
    expect(await got).toEqual([{ ref: 'in:a' } as never]);
  });

  it('reads since: fix as when its card last moved to Fixed', async () => {
    const got = data.since('fix', { cardId: 'c1' });
    http.expectOne('http://alfred.test/board/cards/c1/activity?offset=0&limit=1000').flush({ total: 3, entries: [
      { kind: 'STATUS', newValue: 'FIXED', at: '2026-10-13T09:00:00Z' }, { kind: 'STATUS', newValue: 'IN_PROGRESS', at: '2026-10-13T10:00:00Z' },
      { kind: 'STATUS', newValue: 'FIXED', at: '2026-10-14T09:00:00Z' }] });
    expect(await got).toBe('2026-10-14T09:00:00Z');
    await expectAsync(data.since('fix', {})).toBeRejectedWithError(/on a card/);
    await expectAsync(data.since('last tuesday', {})).toBeRejectedWithError(/ISO time/);
  });

  it('reads one call from the live log or the cycle that captured it', async () => {
    const live = data.read('call', { ref: 'in:a1' });
    http.expectOne('http://alfred.test/internal-calls/a1/detail').flush({ response: { status: 500 } });
    expect(await live).toEqual({ response: { status: 500 } } as never);
    const captured = data.read('call', { ref: '@[call:out:b2@c9|GET /x]' });
    http.expectOne((r) => r.url.includes('/session-cycles/c9/') && r.url.includes('b2')).flush({});
    await captured;
  });
});
