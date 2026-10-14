import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../../../core/models/board.models';
import { SnippetPage } from '../../../core/models/snippet.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SnippetRunSetting } from './snippet-host.component';
import { BoardPagesComponent } from './board-pages.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';

const page = (id: string, name: string, extra: Partial<SnippetPage> = {}): SnippetPage => ({
  id, ownerType: 'CARD', ownerId: 'c1', project: 'odeysys', cardId: 'c1', cycleId: null, name, kind: 'HTML', info: 'live', source: null,
  author: 'USER', pinned: false, position: 0, version: 1, createdAt: '2026-10-14T09:00:00Z', updatedAt: '2026-10-14T09:00:00Z', updatedBy: 'USER',
  ...extra,
});

describe('BoardPagesComponent', () => {
  let http: HttpTestingController;
  const events = new Subject<BoardSocketEvent>();
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test' } },
        { provide: BoardSocketService, useValue: { events$: events.asObservable() } }],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(SnippetRunSetting).onOpen.set(false);
  });

  afterEach(() => TestBed.inject(SnippetRunSetting).onOpen.set(true));

  async function render() {
    const f = TestBed.createComponent(BoardPagesComponent);
    f.componentRef.setInput('owner', 'card:c1');
    f.detectChanges();
    TestBed.flushEffects();
    await flush();
    return f;
  }

  it('shows the pages as tabs, opens the first and re-reads them on its card\'s signal', async () => {
    const f = await render();
    http.expectOne('http://alfred.test/board/pages?owner=card:c1').flush([page('p-1', 'Dashboard', { author: 'CLAUDE' }), page('p-2', 'Timeline')]);
    await flush();
    http.expectOne('http://alfred.test/board/snippets/p-1').flush(page('p-1', 'Dashboard', { source: '<b>x</b>', author: 'CLAUDE' }));
    await flush();
    f.detectChanges();
    const tabs = [...f.nativeElement.querySelectorAll('.board-tab')].map((b: Element) => b.textContent!.trim());
    expect(tabs[0]).toContain('Dashboard');
    expect(tabs[0]).toContain('✦');
    expect(f.nativeElement.querySelector('app-snippet-host')).not.toBeNull();

    events.next({ type: 'board-changed', cardId: 'other', what: 'pages' });
    http.expectNone('http://alfred.test/board/pages?owner=card:c1');
    events.next({ type: 'board-changed', cardId: 'c1', what: 'pages' });
    await flush();
    http.expectOne('http://alfred.test/board/pages?owner=card:c1').flush([page('p-1', 'Dashboard', { version: 2 })]);
    await flush();
    http.expectOne('http://alfred.test/board/snippets/p-1').flush(page('p-1', 'Dashboard', { version: 2, source: 'v2' }));
    await flush();
    expect(f.componentInstance.source()).toBe('v2');
  });

  it('saves an edit from the version it started on and says so when someone saved in between', async () => {
    const f = await render();
    http.expectOne('http://alfred.test/board/pages?owner=card:c1').flush([page('p-1', 'Dashboard')]);
    await flush();
    http.expectOne('http://alfred.test/board/snippets/p-1').flush(page('p-1', 'Dashboard', { source: 'v1' }));
    await flush();
    const c = f.componentInstance;
    c.edit(c.selected()!);
    expect(c.editing()!.info).toContain('name="Dashboard"');
    const saving = c.save({ text: 'v2', info: 'live name="Board"' });
    const put = http.expectOne('http://alfred.test/board/snippets/p-1');
    expect(put.request.body).toEqual({ name: 'Board', info: 'live name="Board"', source: 'v2', baseVersion: 1 });
    put.flush({ error: 'conflict', message: 'The page was saved again' }, { status: 409, statusText: 'Conflict' });
    await saving;
    expect(c.error()).toBe('The page was saved again');
  });

  it('creates a page in its place with a name from the editor', async () => {
    const f = await render();
    http.expectOne('http://alfred.test/board/pages?owner=card:c1').flush([]);
    await flush();
    const c = f.componentInstance;
    c.startNew('HTML');
    const saving = c.save({ text: '<b>x</b>', info: 'live name="Fare dashboard" libs="echarts"' });
    const post = http.expectOne('http://alfred.test/board/pages');
    expect(post.request.body).toEqual({ owner: 'card:c1', project: null, name: 'Fare dashboard', kind: 'HTML', info: 'live name="Fare dashboard" libs="echarts"', source: '<b>x</b>' });
    post.flush(page('p-9', 'Fare dashboard'));
    await flush();
    http.expectOne('http://alfred.test/board/pages?owner=card:c1').flush([page('p-9', 'Fare dashboard')]);
    await flush();
    http.expectOne('http://alfred.test/board/snippets/p-9').flush(page('p-9', 'Fare dashboard', { source: '<b>x</b>' }));
    await saving;
    expect(c.selectedId()).toBe('p-9');
  });
});

describe('inline snippet ids', () => {
  it('number every snippet of a text in reading order under where the text is saved', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: BoardSocketService, useValue: { events$: new Subject<BoardSocketEvent>() } }] });
    TestBed.inject(SnippetRunSetting).onOpen.set(false);
    const f = TestBed.createComponent(MarkdownViewComponent);
    f.componentRef.setInput('text', '```html live\na\n```\n\n:::tabs\n## One\n```mermaid\nflowchart LR\n A-->B\n```\n## Two\n```html live\nb\n```\n:::');
    f.componentRef.setInput('snippetOwner', 'inline:card:c1:desc');
    f.detectChanges();
    const v = f.componentInstance;
    const blocks = v.blocks();
    expect(v.inlineId(blocks[0])).toBe('inline:card:c1:desc:0');
    const tabs = blocks[1] as Extract<typeof blocks[number], { kind: 'tabs' }>;
    expect(v.inlineId(tabs.tabs[0].blocks[0])).toBe('inline:card:c1:desc:1');
    expect(v.inlineId(tabs.tabs[1].blocks[0])).toBe('inline:card:c1:desc:2');
    f.componentRef.setInput('snippetOwner', null);
    expect(v.inlineId(blocks[0])).toBeNull();
    TestBed.inject(SnippetRunSetting).onOpen.set(true);
  });
});
