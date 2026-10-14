import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../../../core/models/board.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SnippetShelfService } from '../../../core/services/snippet-shelf.service';
import { SnippetHostComponent, SnippetRunSetting } from './snippet-host.component';
import { SnippetDataService } from '../../../core/services/snippet-data.service';

/** The whole road in a real locked frame: snippet → bridge → host → Alfred's API, and Alfred's signal back in. */
describe('SnippetHostComponent with a saved snippet', () => {
  let http: HttpTestingController;
  const events = new Subject<BoardSocketEvent>();
  const base = 'http://alfred.test/board/snippets/p-1';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function until<T>(get: () => T | null | undefined, ms = 8000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await wait(25);
    }
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test' } },
        { provide: BoardSocketService, useValue: { events$: events.asObservable() } },
        { provide: SnippetShelfService, useValue: { canLoadDirect: () => Promise.resolve(true), inline: () => Promise.resolve({}) } }],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(SnippetRunSetting).onOpen.set(true);
  });

  it('saves and reads alfred.state, hears another viewer\'s change, and keeps a shot of its version', async () => {
    const f = TestBed.createComponent(SnippetHostComponent);
    f.componentRef.setInput('source', '<div id="n" style="height:40px">-</div><script>'
      + 'alfred.state.get("count").then(function (v) { console.log("got " + v); return alfred.state.set("count", (v || 0) + 1); })'
      + '.then(function (v) { console.log("set " + v); });'
      + 'alfred.on("state", function (c) { console.log("heard " + c.key + "=" + JSON.stringify(c.value)); });</script>');
    f.componentRef.setInput('snippetId', 'p-1');
    f.componentRef.setInput('version', 4);
    document.body.appendChild(f.nativeElement);
    f.detectChanges();
    TestBed.flushEffects();

    const read = await until(() => http.match(base + '/state')[0]);
    read.flush([{ snippetId: 'p-1', key: 'count', value: '2', updatedBy: 'USER', at: '' }]);
    const put = await until(() => http.match(base + '/state/count')[0]);
    expect(put.request.body).toEqual({ value: 3 });
    put.flush({});
    await until(() => f.componentInstance.lines().some((l) => l.text === 'set 3'));
    expect(f.componentInstance.lines().map((l) => l.text)).toContain('got 2');

    events.next({ type: 'board-changed', what: 'state:p-1' });
    const again = await until(() => http.match(base + '/state')[0]);
    again.flush([{ snippetId: 'p-1', key: 'count', value: '7', updatedBy: 'USER', at: '' }]);
    await until(() => f.componentInstance.lines().some((l) => l.text === 'heard count=7'));

    const meta = await until(() => http.match(base + '/shot?png=false')[0], 6000);
    meta.flush({}, { status: 404, statusText: 'None' });
    const shot = await until(() => http.match(base + '/shot')[0], 8000);
    expect(shot.request.body.version).toBe(4);
    expect(shot.request.body.png).toMatch(/^data:image\/png;base64,/);
    expect(shot.request.body.console).toContain('set 3');
    shot.flush(null);
    f.destroy();
  }, 30000);
});

describe('SnippetHostComponent data bridge', () => {
  const changed = new Subject<void>();
  let reads: { src: string; args: Record<string, unknown>; ctx: unknown }[];
  let answer = 1;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    reads = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: SnippetShelfService, useValue: { canLoadDirect: () => Promise.resolve(true), inline: () => Promise.resolve({}) } },
        { provide: SnippetDataService, useValue: {
          read: async (src: string, args: Record<string, unknown>, ctx: unknown) => { reads.push({ src, args, ctx }); return [{ n: answer }]; },
          changes: () => changed.asObservable() } },
      ],
    });
    TestBed.inject(SnippetRunSetting).onOpen.set(true);
  });

  it('answers alfred.data, alfred.watch and a declared live block, and sends a watched source again when calls change', async () => {
    const f = TestBed.createComponent(SnippetHostComponent);
    f.componentRef.setInput('source', '<script type="alfred/data" name="fares" src="calls" live>{"endpoint":"POST /fare"}</script><script>'
      + 'alfred.data("cards", { q: "x" }).then(function (v) { console.log("once " + v[0].n); });'
      + 'alfred.watch("calls", { since: "fix" }, function (v) { console.log("watch " + v[0].n); });'
      + 'alfred.on("fares", function (v) { console.log("fares " + v[0].n); });'
      + 'alfred.value("fares").then(function (v) { console.log("value " + v[0].n); });'
      + 'alfred.data("http://evil.example").catch(function () {});</script>');
    f.componentRef.setInput('context', { project: 'odeysys', cardId: 'c1' });
    document.body.appendChild(f.nativeElement);
    f.detectChanges();
    TestBed.flushEffects();
    const lines = () => f.componentInstance.lines().map((l) => l.text);
    for (let i = 0; i < 200 && !(lines().includes('watch 1') && lines().includes('fares 1') && lines().includes('value 1')); i++) await wait(25);
    expect(lines()).toContain('once 1');
    expect(reads.find((r) => r.src === 'calls' && r.args['endpoint'] === 'POST /fare')?.ctx).toEqual({ project: 'odeysys', cardId: 'c1', cycleId: null });

    answer = 2;
    changed.next();
    for (let i = 0; i < 200 && !(lines().includes('watch 2') && lines().includes('fares 2')); i++) await wait(25);
    expect(lines()).toContain('watch 2');
    expect(lines()).toContain('fares 2');
    expect(lines()).not.toContain('once 2');
    f.destroy();
  }, 20000);
});
