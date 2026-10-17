import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, filter, forkJoin, map, of } from 'rxjs';
import { CallRecord, SessionCycle } from '../../../core/models/call.model';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { callTime } from '../../../shared/utils/call-utils';

/** One call in the board's Calls tab, with the cycle it was captured in. */
export interface BoardCallRow {
  readonly call: CallRecord;
  readonly cycleId: string;
  readonly cycleName: string;
  /** 0..5: the cycle's colour. */
  readonly tone: number;
  readonly at: number;
  readonly path: string;
  readonly status: number | null;
  readonly bad: boolean;
}

type Direction = 'all' | 'in' | 'out';

/** "/api/x?y=1" from a full URL; the URL itself when it is not one. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Rows of every cycle's calls, newest first or grouped by cycle, narrowed by cycle, text, direction and problems.
 * A problem is a status of 400 or more, or a call that ended in an error.
 */
export function boardCallRows(byCycle: ReadonlyMap<string, readonly CallRecord[]>, cycles: readonly Pick<SessionCycle, 'id' | 'name'>[],
                              f: { cycle: string | null; q: string; dir: Direction; problems: boolean; grouped: boolean }): BoardCallRow[] {
  const q = f.q.trim().toLowerCase();
  const rows: BoardCallRow[] = [];
  cycles.forEach((c, i) => {
    if (f.cycle && f.cycle !== c.id) return;
    for (const call of byCycle.get(c.id) ?? []) {
      const status = call.response?.status ?? null;
      const bad = !!call.error || (status != null && status >= 400);
      const dirIn = call.source === 'internal';
      if (f.dir === 'in' && !dirIn) continue;
      if (f.dir === 'out' && dirIn) continue;
      if (f.problems && !bad) continue;
      const path = pathOf(call.url);
      if (q && !`${call.method} ${call.url} ${status ?? ''} ${call.error ?? ''}`.toLowerCase().includes(q)) continue;
      rows.push({ call, cycleId: c.id, cycleName: c.name, tone: i % 6, at: callTime(call), path, status, bad });
    }
  });
  const order = new Map(cycles.map((c, i) => [c.id, i]));
  return rows.sort((a, b) => (f.grouped ? (order.get(a.cycleId) ?? 0) - (order.get(b.cycleId) ?? 0) : 0) || b.at - a.at);
}

/**
 * The board's Calls tab (specs/029): every call of every cycle on the board in one list, each tagged with its cycle,
 * a divider where the list moves from one cycle to another. A row opens the call popup. Read when the tab opens, again
 * when a cycle's contents change (the session-cycles signal) or on ↻ - never polled.
 */
@Component({
  selector: 'app-board-calls',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  template: `
    <div class="bc-bar">
      <input class="bc-q" type="search" placeholder="Search method, path, status, error…" [value]="q()" (input)="q.set($any($event.target).value)" />
      <button type="button" class="bc-chip" [class.on]="!cycle()" (click)="cycle.set(null)">All cycles · {{ total() }}</button>
      @for (c of cycles(); track c.id; let i = $index) {
        <button type="button" class="bc-chip" [class.on]="cycle() === c.id" (click)="cycle.set(cycle() === c.id ? null : c.id)">
          <i [class]="'bc-dot bc-t' + (i % 6)"></i>{{ c.name }} · {{ counts().get(c.id) ?? 0 }}@if (c.status === 'RECORDING') { <span class="bc-rec">● rec</span> }
        </button>
      }
      <select class="bc-sel" [value]="dir()" (change)="dir.set($any($event.target).value)" aria-label="Direction">
        <option value="all">In and out</option><option value="in">Inbound</option><option value="out">Outbound</option>
      </select>
      <button type="button" class="bc-chip" [class.on]="problems()" (click)="problems.set(!problems())">Problems only</button>
      <button type="button" class="bc-chip" [class.on]="grouped()" (click)="grouped.set(!grouped())">Group by cycle</button>
      <button type="button" class="action-btn" title="Read the calls again" (click)="load()">↻</button>
    </div>
    @if (!cycles().length) {
      <div class="board-dim bc-empty">No cycle on this board yet - attach one, or make one and record into it (Cycles tab).</div>
    } @else if (loading() && !byCycle().size) {
      <div class="board-dim bc-empty">Reading the calls…</div>
    } @else if (!rows().length) {
      <div class="board-dim bc-empty">{{ total() ? 'No call matches.' : 'No calls yet - record into a cycle and they show here.' }}</div>
    } @else {
      <div class="bc-wrap">
        <table class="bc-table">
          <thead><tr><th>Time</th><th>Cycle</th><th></th><th>Method</th><th>Path</th><th>Status</th><th>ms</th></tr></thead>
          <tbody>
            @for (r of shown(); track r.cycleId + r.call.id; let i = $index) {
              @if (i > 0 && shown()[i - 1].cycleId !== r.cycleId) {
                <tr class="bc-gap"><td colspan="7">── {{ r.cycleName }} ──</td></tr>
              }
              <tr class="bc-row" [class.bad]="r.bad" tabindex="0" (click)="openCall(r)" (keydown.enter)="openCall(r)">
                <td class="bc-at">{{ r.at | date: 'd MMM HH:mm:ss' }}</td>
                <td><span [class]="'bc-cy bc-t' + r.tone" [title]="r.cycleName">{{ r.cycleName }}</span></td>
                <td class="bc-dir" [title]="r.call.source === 'internal' ? 'Inbound - into the project' : 'Outbound - to a supplier'">{{ r.call.source === 'internal' ? '↘' : '↗' }}</td>
                <td>{{ r.call.method }}</td>
                <td class="bc-path" [title]="r.call.url">{{ r.path }}</td>
                <td [class.bc-ok]="!r.bad" [class.bc-er]="r.bad">{{ r.status ?? (r.call.error ? 'error' : '…') }}</td>
                <td>{{ r.call.duration_ms | number: '1.0-0' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (rows().length > shown().length) {
        <button type="button" class="action-btn bc-more" (click)="limit.set(limit() + 500)">Show {{ rows().length - shown().length }} more</button>
      }
    }
    @if (error()) { <div class="board-error">{{ error() }}</div> }`,
  styles: [`
    .bc-bar { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-bottom: .6rem; }
    .bc-q { flex: 1 1 220px; min-width: 0; height: 1.9rem; padding: .2rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px;
      background: var(--card-inner); color: var(--text); font: inherit; font-size: .82rem; }
    .bc-sel { height: 1.9rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: var(--text); font: inherit; font-size: .8rem; }
    .bc-chip { display: inline-flex; gap: .3rem; align-items: center; max-width: 280px; padding: .2rem .55rem; border: 1px solid var(--border);
      border-radius: 999px; background: none; color: var(--text-dim); font: inherit; font-size: .78rem; cursor: pointer; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .bc-chip.on { color: var(--text); border-color: var(--accent, #8b5cf6); background: rgba(139,92,246,.12); }
    .bc-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
    .bc-rec { color: var(--red); }
    .bc-wrap { overflow-x: auto; }
    .bc-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .bc-table th { text-align: left; font-weight: 500; color: var(--text-faint); padding: .3rem .45rem; border-bottom: 1px solid var(--border); }
    .bc-table td { padding: .3rem .45rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .bc-row { cursor: pointer; }
    .bc-row:hover td, .bc-row:focus td { background: var(--card-inner); outline: none; }
    .bc-row.bad td { background: rgba(229,83,75,.07); }
    .bc-gap td { color: var(--text-faint); font-size: .72rem; padding: .15rem .45rem; }
    .bc-at { color: var(--text-dim); }
    .bc-path { max-width: 520px; overflow: hidden; text-overflow: ellipsis; }
    .bc-dir { color: var(--text-dim); }
    .bc-ok { color: var(--green); } .bc-er { color: var(--red); }
    .bc-cy { display: inline-block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; padding: 0 .4rem;
      border: 1px solid var(--border); border-radius: 999px; font-size: .72rem; }
    .bc-t0 { color: #7fb4ff; } .bc-t1 { color: #c39bff; } .bc-t2 { color: #f0a83a; } .bc-t3 { color: #5fd3a8; } .bc-t4 { color: #f27fa6; } .bc-t5 { color: #d6d36a; }
    .bc-empty { padding: 1rem 0; }
    .bc-more { margin-top: .5rem; }
  `],
})
export class BoardCallsComponent {
  private readonly mentions = inject(BoardMentionsService);

  /** The board's cycles, in the order the board lists them. */
  readonly cycles = input<readonly Pick<SessionCycle, 'id' | 'name' | 'status'>[]>([]);

  readonly byCycle = signal<ReadonlyMap<string, readonly CallRecord[]>>(new Map());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cycle = signal<string | null>(null);
  readonly q = signal('');
  readonly dir = signal<Direction>('all');
  readonly problems = signal(false);
  readonly grouped = signal(false);
  /** Rows drawn at once; "Show more" adds to it. */
  readonly limit = signal(500);

  readonly counts = computed(() => new Map([...this.byCycle()].map(([id, calls]) => [id, calls.length])));
  readonly total = computed(() => [...this.counts().values()].reduce((a, b) => a + b, 0));
  readonly rows = computed(() => boardCallRows(this.byCycle(), this.cycles(),
    { cycle: this.cycle(), q: this.q(), dir: this.dir(), problems: this.problems(), grouped: this.grouped() }));
  readonly shown = computed(() => this.rows().slice(0, this.limit()));

  constructor() {
    effect(() => {
      const ids = this.cycles().map((c) => c.id).join(',');
      untracked(() => {
        if (this.cycle() && !ids.split(',').includes(this.cycle()!)) this.cycle.set(null);
        this.load();
      });
    });
    const sub = inject(SessionCyclesStateService).contentChanged$.pipe(filter((id) => this.cycles().some((c) => c.id === id)))
      .subscribe(() => this.load());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  load(): void {
    const cycles = this.cycles();
    if (!cycles.length) {
      this.byCycle.set(new Map());
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    forkJoin(cycles.map((c) => this.mentions.cycleCalls(c.id).pipe(
      map((calls) => [c.id, calls] as const),
      catchError(() => {
        this.error.set('Some cycles could not be read');
        return of([c.id, [] as CallRecord[]] as const);
      })))).subscribe((pairs) => {
      this.loading.set(false);
      this.byCycle.set(new Map(pairs));
    });
  }

  openCall(r: BoardCallRow): void {
    this.mentions.callToShow.set({ direction: r.call.source === 'internal' ? 'in' : 'out', callId: r.call.id, cycleId: r.cycleId,
      label: `${r.call.method} ${r.path}` });
  }
}
