import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { BoardSocketEvent } from '../../../core/models/board.models';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SnippetDataService } from '../../../core/services/snippet-data.service';
import { CallsBlockComponent } from './calls-block.component';
import { CompareBlockComponent } from './data-blocks.component';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('board data blocks', () => {
  const changed = new Subject<void>();
  let reads: { src: string; args: Record<string, unknown> }[];
  let rows: unknown[];

  beforeEach(() => {
    reads = [];
    rows = [
      { ref: 'in:c2', method: 'POST', path: '/fare/7', endpoint: 'POST /fare/{n}', status: 200, signal: 'ok', at: '2026-10-14T10:02:00Z', durationMs: 610, statements: 4, dbMs: 104, errors: 0 },
      { ref: 'in:c1', method: 'POST', path: '/fare/7', endpoint: 'POST /fare/{n}', status: 500, signal: '5xx', at: '2026-10-14T10:01:00Z', durationMs: 2400, statements: null, dbMs: null, errors: 3 },
    ];
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://alfred.test' } },
        { provide: BoardSocketService, useValue: { events$: new Subject<BoardSocketEvent>() } },
        { provide: SnippetDataService, useValue: {
          read: async (src: string, args: Record<string, unknown>) => {
            reads.push({ src, args });
            if (src === 'call') return { response: { status: args['ref'] === 'in:a' ? 500 : 200, body: args['ref'] === 'in:a' ? '{"fare":120}' : '{"fare":100}', headers: {} } };
            return rows;
          },
          changes: () => changed.asObservable() } }],
    });
  });

  it('```calls``` draws the calls with a summary, unknown as a dash, failures in red - and reads again when calls arrive', async () => {
    const f = TestBed.createComponent(CallsBlockComponent);
    f.componentRef.setInput('source', 'endpoint: POST /fare\nsince: fix\nshow: table(status, ms, sql, errors)');
    f.componentRef.setInput('context', { project: 'odeysys', cardId: 'c9' });
    f.detectChanges();
    TestBed.flushEffects();
    await flush();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.board-query-sum')!.textContent).toContain('2 calls');
    expect(el.querySelector('.board-query-sum')!.textContent).toContain('1 failed');
    const cells = Array.from(el.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).slice(1).map((td) => td.textContent!.trim()));
    expect(cells).toEqual([['200', '610', '4', '0'], ['500', '2400', '–', '3']]);
    expect(el.querySelector('tbody tr:nth-child(2) td:nth-child(2)')!.className).toContain('c-red');
    expect(reads[0].args['since']).toBe('fix');

    changed.next();
    await flush();
    expect(reads.length).toBe(2);
  });

  it('```calls``` as a chart', async () => {
    const f = TestBed.createComponent(CallsBlockComponent);
    f.componentRef.setInput('source', 'endpoint: POST /fare\nshow: chart(ms)');
    f.detectChanges();
    TestBed.flushEffects();
    await flush();
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('app-chart-block svg')).not.toBeNull();
  });

  it('```compare``` puts two calls side by side and shows where the bodies differ', async () => {
    const http = TestBed.inject(HttpTestingController);
    const f = TestBed.createComponent(CompareBlockComponent);
    f.componentRef.setInput('source', '@[call:in:a|POST /fare · 500]\n@[call:in:b|POST /fare · 200]');
    f.detectChanges();
    await flush();
    for (const r of http.match(() => true)) r.flush({});
    await flush();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const status = Array.from(el.querySelectorAll('tbody tr'))[0];
    expect(status.textContent).toContain('500');
    expect(status.textContent).toContain('200');
    expect(status.classList).toContain('diff');
    const parts = Array.from(el.querySelectorAll('summary')).map((s) => s.textContent!.trim());
    expect(parts).toContain('Response body · differs');
    expect(parts).toContain('Request headers · same');
  });
});
