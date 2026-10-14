import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../models/board.models';
import { AppConfigService } from './app-config.service';
import { BoardSocketService } from './board-socket.service';
import { SnippetStoreService, sourceHash } from './snippet-store.service';

describe('SnippetStoreService', () => {
  let http: HttpTestingController;
  let store: SnippetStoreService;
  const events = new Subject<BoardSocketEvent>();
  const base = 'http://alfred.test/board/snippets/';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test' } },
        { provide: BoardSocketService, useValue: { events$: events.asObservable() } }],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(SnippetStoreService);
  });

  afterEach(() => http.verify());

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reads the saved values once, saves a value as JSON and keeps it', async () => {
    const m = store.memory('p-1');
    const got = m.get('filter');
    http.expectOne(base + 'p-1/state').flush([{ snippetId: 'p-1', key: 'filter', value: '{"status":500}', updatedBy: 'USER', at: '' }]);
    expect(await got).toEqual({ status: 500 });

    const saved = m.set('n', [1, 2]);
    const req = http.expectOne(base + 'p-1/state/n');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ value: [1, 2] });
    req.flush({});
    await saved;
    expect(await m.all()).toEqual({ filter: { status: 500 }, n: [1, 2] });
  });

  it('a refusal comes back to the snippet with its reason', async () => {
    const m = store.memory('p-1');
    const saved = m.set('big', 'x');
    http.expectOne(base + 'p-1/state/big').flush({ message: 'A saved value can be at most 64 KB' }, { status: 400, statusText: 'Bad' });
    await expectAsync(saved).toBeRejectedWithError('A saved value can be at most 64 KB');
  });

  it('after a state signal it says which keys someone else changed', async () => {
    const m = store.memory('inline:card:c1:desc:0');
    let signalled = 0;
    m.changes$.subscribe(() => signalled++);
    events.next({ type: 'board-changed', what: 'state:other' });
    events.next({ type: 'board-changed', what: 'state:inline:card:c1:desc:0' });
    expect(signalled).toBe(1);

    const first = m.all();
    http.expectOne(base + encodeURIComponent('inline:card:c1:desc:0') + '/state').flush([
      { snippetId: 'x', key: 'a', value: '1', updatedBy: 'USER', at: '' }, { snippetId: 'x', key: 'b', value: '2', updatedBy: 'USER', at: '' }]);
    await first;
    const changed = m.refresh();
    await flush();
    http.expectOne(base + encodeURIComponent('inline:card:c1:desc:0') + '/state').flush([
      { snippetId: 'x', key: 'a', value: '1', updatedBy: 'USER', at: '' }, { snippetId: 'x', key: 'c', value: '3', updatedBy: 'USER', at: '' }]);
    expect(await changed).toEqual([{ key: 'c', value: 3 }, { key: 'b', value: null }]);
  });

  it('keeps a shot only when this version has none yet', async () => {
    let drawn = 0;
    const take = async () => { drawn++; return 'data:image/png;base64,AAA'; };
    const same = store.keepShot('p-1', 3, take, () => []);
    http.expectOne(base + 'p-1/shot?png=false').flush({ snippetId: 'p-1', version: 3, at: '', console: '' });
    expect(await same).toBeFalse();
    expect(drawn).toBe(0);

    const newer = store.keepShot('p-1', 4, take, () => ['error: x']);
    http.expectOne(base + 'p-1/shot?png=false').flush({ snippetId: 'p-1', version: 3, at: '', console: '' });
    await flush();
    const put = http.expectOne(base + 'p-1/shot');
    expect(put.request.body).toEqual({ version: 4, png: 'data:image/png;base64,AAA', console: ['error: x'] });
    put.flush(null);
    expect(await newer).toBeTrue();

    const none = store.keepShot('p-2', 1, take, () => []);
    http.expectOne(base + 'p-2/shot?png=false').flush({}, { status: 404, statusText: 'No' });
    await flush();
    http.expectOne(base + 'p-2/shot').flush({}, { status: 403, statusText: 'Read-only' });
    expect(await none).toBeFalse();
  });

  it('gives an inline block a stable, positive number for its source', () => {
    expect(sourceHash('<b>x</b>')).toBe(sourceHash('<b>x</b>'));
    expect(sourceHash('<b>x</b>')).not.toBe(sourceHash('<b>y</b>'));
    expect(sourceHash('a'.repeat(5000))).toBeGreaterThanOrEqual(0);
  });
});
