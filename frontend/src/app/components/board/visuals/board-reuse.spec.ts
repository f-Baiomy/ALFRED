import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../../../core/models/board.models';
import { SnippetPage } from '../../../core/models/snippet.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { fillWidget } from '../../../core/services/widgets.service';
import { blockTitle, fenceOf, toFence } from '../../../shared/utils/board-visuals';
import { markdownBlocks } from '../../../shared/utils/markdown-blocks';
import { blocksToHtml, blocksToMarkdown, htmlBlocks } from '../../../shared/utils/rich-html';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { BoardFilesComponent, fileLink, fileProblem, fileSize } from './board-files.component';
import { BoardPagesComponent } from './board-pages.component';
import { BoardPinnedComponent } from './board-pinned.component';
import { SnippetRunSetting } from './snippet-host.component';

const API = 'http://alfred.test/board';
const page = (id: string, name: string, extra: Partial<SnippetPage> = {}): SnippetPage => ({
  id, ownerType: 'CARD', ownerId: 'c1', project: 'odeysys', cardId: 'c1', cycleId: null, name, kind: 'HTML', info: 'live', source: null,
  author: 'USER', pinned: false, position: 0, version: 1, createdAt: '2026-10-14T09:00:00Z', updatedAt: '2026-10-14T09:00:00Z', updatedBy: 'USER',
  ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('files, pins and widgets (specs/017 R33, R34, R36)', () => {
  let http: HttpTestingController;
  const events = new Subject<BoardSocketEvent>();

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

  describe('files', () => {
    it('checks a file before sending it, and links it as a chip the board downloads', () => {
      expect(fileProblem({ name: 'rows.csv', size: 10 })).toBeNull();
      expect(fileProblem({ name: 'page.html', size: 10 })).toContain('one of');
      expect(fileProblem({ name: 'big.log', size: 11 * 1024 * 1024 })).toContain('10 MB');
      expect(fileProblem({ name: 'empty.txt', size: 0 })).toContain('empty');
      expect(fileSize(2048)).toBe('2.0 KB');
      expect(fileLink({ id: 'f-12345678', name: 'a[1].csv' })).toBe('[📎 a1.csv](/board/files/f-12345678)');

      const md = '[📎 rows.csv](/board/files/f-12345678) and [x](/settings)';
      const blocks = markdownBlocks(md);
      expect(blocksToMarkdown(blocks)).toBe('[📎 rows.csv](/board/files/f-12345678) and [x](/settings)');
      const html = blocksToHtml(blocks);
      expect(html).toContain('<a href="/board/files/f-12345678">');
      expect(html).not.toContain('href="/settings"');
      expect(blocksToMarkdown(htmlBlocks(html))).toContain('[📎 rows.csv](/board/files/f-12345678)');
    });

    it('draws a file link as a download, never a page in a new tab', () => {
      const f = TestBed.createComponent(MarkdownViewComponent);
      f.componentRef.setInput('text', 'See [📎 rows.csv](/board/files/f-12345678)');
      f.detectChanges();
      const a = (f.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a.board-file-link')!;
      expect(a.getAttribute('href')).toBe('/board/files/f-12345678');
      expect(a.hasAttribute('download')).toBeTrue();
      expect(a.getAttribute('target')).toBeNull();
    });

    it('lists a card\'s files, attaches more and re-reads on its signal', async () => {
      const f = TestBed.createComponent(BoardFilesComponent);
      f.componentRef.setInput('card', 'c1');
      f.detectChanges();
      TestBed.flushEffects();
      http.expectOne(`${API}/files?card=c1`).flush([{ id: 'f-12345678', project: 'p', cardId: 'c1', cycleId: null, name: 'rows.csv', mime: 'text/csv', size: 2048, author: 'USER', createdAt: '' }]);
      await flush();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('rows.csv');
      expect(f.nativeElement.textContent).toContain('2.0 KB');

      const done = f.componentInstance.attach([new File(['a,b'], 'more.csv'), new File(['x'], 'bad.exe')]);
      const post = http.expectOne((r) => r.method === 'POST' && r.url === `${API}/files`);
      expect(post.request.params.get('card')).toBe('c1');
      expect(post.request.params.get('name')).toBe('more.csv');
      post.flush({ id: 'f-87654321', name: 'more.csv' });
      await flush();
      http.expectOne(`${API}/files?card=c1`).flush([]);
      expect((await done).length).toBe(1);
      expect(f.componentInstance.error()).toContain('bad.exe');

      events.next({ type: 'board-changed', what: 'files', cardId: 'c1' } as BoardSocketEvent);
      http.expectOne(`${API}/files?card=c1`).flush([]);
      events.next({ type: 'board-changed', what: 'files', cardId: 'other' } as BoardSocketEvent);
      http.verify();
    });
  });

  describe('pins', () => {
    it('keeps a fixed block as its fence and reads it back', () => {
      const md = toFence('chart', 'name="Fares"', 'type: bar\na: 1\n');
      expect(md).toBe('```chart name="Fares"\ntype: bar\na: 1\n```');
      expect(fenceOf(md)).toEqual({ lang: 'chart', info: 'name="Fares"', text: 'type: bar\na: 1' });
      expect(fenceOf('two\n```chart\n```')).toBeNull();
      expect(blockTitle('chart', 'name="Fares"')).toBe('Fares');
      expect(blockTitle('stats', '')).toBe('Stats');
    });

    it('📌 on a block of a card makes it a pinned page of the card; not in a preview', async () => {
      const f = TestBed.createComponent(MarkdownViewComponent);
      f.componentRef.setInput('text', '```stats\nSQL | 4\n```');
      f.componentRef.setInput('snippetContext', { cardId: 'c1', project: 'odeysys' });
      f.detectChanges();
      const pin = (f.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.board-vis-pin button')!;
      pin.click();
      const create = http.expectOne(`${API}/pages`);
      expect(create.request.body).toEqual(jasmine.objectContaining({ owner: 'card:c1', project: 'odeysys', kind: 'BLOCK', name: 'Stats', source: '```stats\nSQL | 4\n```' }));
      create.flush(page('p-1', 'Stats', { kind: 'BLOCK' }));
      await flush();
      const upd = http.expectOne(`${API}/snippets/p-1`);
      expect(upd.request.body).toEqual({ pinned: true });
      upd.flush(page('p-1', 'Stats', { kind: 'BLOCK', pinned: true }));

      f.componentRef.setInput('previews', false);
      f.detectChanges();
      expect((f.nativeElement as HTMLElement).querySelector('.board-vis-pin')).toBeNull();
    });

    it('pinned pages show open at the top; the tabs hold the rest', async () => {
      const pinned = TestBed.createComponent(BoardPinnedComponent);
      pinned.componentRef.setInput('owner', 'card:c1');
      pinned.detectChanges();
      TestBed.flushEffects();
      const tabs = TestBed.createComponent(BoardPagesComponent);
      tabs.componentRef.setInput('owner', 'card:c1');
      tabs.detectChanges();
      TestBed.flushEffects();
      const list = [page('p-1', 'Fare dashboard', { kind: 'BLOCK', pinned: true }), page('p-2', 'Notes')];
      for (const r of http.match(`${API}/pages?owner=card:c1`)) r.flush(list);
      await flush();
      http.expectOne(`${API}/snippets/p-1`).flush({ ...list[0], source: '```stats\nSQL | 4\n```' });
      http.expectOne(`${API}/snippets/p-2`).flush({ ...list[1], source: '<b>n</b>' });
      await flush();
      pinned.detectChanges();
      tabs.detectChanges();
      expect(pinned.nativeElement.textContent).toContain('📌 Fare dashboard');
      expect(pinned.nativeElement.querySelector('.board-stat, app-stats-block')).not.toBeNull();
      expect(tabs.componentInstance.tabs().map((p) => p.name)).toEqual(['Notes']);
    });
  });

  describe('widgets', () => {
    it('reads {{widget:name | key=value}} as its own line, and writes it back', () => {
      const [b] = markdownBlocks('{{widget:fare-chart | endpoint=/api/fare; since="24h"}}');
      expect(b).toEqual({ kind: 'widget', name: 'fare-chart', args: 'endpoint=/api/fare; since="24h"', params: { endpoint: '/api/fare', since: '24h' } });
      expect(blocksToMarkdown([b])).toBe('{{widget:fare-chart | endpoint=/api/fare; since="24h"}}');
      expect(blocksToMarkdown(htmlBlocks(blocksToHtml([b])))).toBe('{{widget:fare-chart | endpoint=/api/fare; since="24h"}}');
      expect(markdownBlocks('text {{widget:x}} inline')[0].kind).toBe('paragraph');
      expect(fillWidget('{{endpoint}} in {{since}} {{missing}}', { endpoint: '/a', since: '1h' })).toBe('/a in 1h {{missing}}');
    });

    it('draws a widget from the project with its values, and stops a widget that uses itself', async () => {
      const f = TestBed.createComponent(MarkdownViewComponent);
      f.componentRef.setInput('text', '{{widget:sql | n=7}}');
      f.componentRef.setInput('snippetContext', { project: 'odeysys' });
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('★ sql…');
      http.expectOne(`${API}/widgets/sql?project=odeysys`).flush({ project: 'odeysys', name: 'sql', kind: 'BLOCK', info: '', source: '**SQL {{n}}**\n\n{{widget:sql}}', author: 'USER', updatedAt: '', updatedBy: 'USER' });
      await flush();
      f.detectChanges();
      expect(f.nativeElement.textContent).toContain('SQL 7');
      expect(f.nativeElement.textContent).toContain('three deep');

      const missing = TestBed.createComponent(MarkdownViewComponent);
      missing.componentRef.setInput('text', '{{widget:gone}}');
      missing.componentRef.setInput('snippetContext', { project: 'odeysys' });
      missing.detectChanges();
      http.expectOne(`${API}/widgets/gone?project=odeysys`).flush({ message: 'No widget "gone" in this project' }, { status: 404, statusText: 'Not Found' });
      await flush();
      missing.detectChanges();
      expect(missing.nativeElement.textContent).toContain('No widget "gone"');
    });
  });
});
