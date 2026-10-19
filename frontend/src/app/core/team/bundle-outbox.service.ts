import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { forkJoin } from 'rxjs';
import { TeamApiService } from './team-api.service';
import { TeamStateService } from './team-state.service';
import { WriteBundle } from './team.models';

/**
 * What a board has ready to send to the tracker (specs/034): its waiting consent bundles, and the ones that ended with a
 * step refused (to retry). Read when a board opens and again on every "write" signal of /ws/teamboards - never polled.
 * The header's ⇪ pill and tray, the card tiles' badges, the card drawer's strip and the chat all read it from here, and
 * while something waits the tab's title says ⇪n so it shows from another tab (no pop-ups, no sounds).
 */
@Injectable({ providedIn: 'root' })
export class BundleOutboxService {
  private readonly api = inject(TeamApiService);
  private readonly team = inject(TeamStateService);

  readonly board = signal<string | null>(null);
  readonly waiting = signal<readonly WriteBundle[]>([]);
  readonly partial = signal<readonly WriteBundle[]>([]);
  /** Sent or rejected ones, for the chat's trail under the answer that made them. */
  readonly ended = signal<readonly WriteBundle[]>([]);
  /** Every bundle of the board by the chat message that asked for it ({@code askedIn}). */
  readonly byAsk = computed(() => {
    const m = new Map<string, WriteBundle[]>();
    for (const b of [...this.waiting(), ...this.partial(), ...this.ended()]) {
      if (b.askedIn) m.set(b.askedIn, [...(m.get(b.askedIn) ?? []), b].sort((x, y) => x.id - y.id));
    }
    return m;
  });
  readonly count = computed(() => this.waiting().length);
  /** Waiting bundles per card id. */
  readonly byCard = computed(() => {
    const m = new Map<string, WriteBundle[]>();
    for (const b of this.waiting()) if (b.cardId) m.set(b.cardId, [...(m.get(b.cardId) ?? []), b]);
    return m;
  });
  /** Waiting changes (ticked steps) in all. */
  readonly changes = computed(() => this.waiting().reduce((n, b) => n + b.steps.filter((s) => s.ticked).length, 0));
  private seq = 0;

  constructor() {
    effect(() => {
      const e = this.team.boardEvent();
      const board = this.board();
      if (!e || !board || e.what !== 'write') return;
      if (e.board && e.board !== board) return;
      untracked(() => this.load());
    }, { allowSignalWrites: true });
    effect(() => {
      const n = this.count();
      untracked(() => this.title(n));
    });
    if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
      // other parts of the page write their own count into the title: ours is put back after them
      const obs = new MutationObserver(() => this.title(this.count()));
      const head = document.querySelector('head');
      if (head) obs.observe(head, { subtree: true, childList: true, characterData: true });
      inject(DestroyRef).onDestroy(() => obs.disconnect());
    }
  }

  /** The board the page shows (null: none). */
  watch(boardId: string | null): void {
    if (this.board() === boardId) return;
    this.board.set(boardId);
    this.waiting.set([]);
    this.partial.set([]);
    this.ended.set([]);
    if (boardId) this.load();
  }

  load(): void {
    const board = this.board();
    if (!board) return;
    const ask = ++this.seq;
    forkJoin([this.api.bundles({ board, state: 'WAITING' }), this.api.bundles({ board, state: 'PARTIAL' }), this.api.bundles({ board, state: 'DONE' }),
      this.api.bundles({ board, state: 'REJECTED' })]).subscribe({
      next: ([w, p, d, r]) => {
        if (ask !== this.seq) return;
        this.waiting.set([...w].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        this.partial.set(p);
        this.ended.set([...d, ...r]);
      },
      error: () => undefined,
    });
  }

  /** A bundle changed on the page: show it at once (the socket confirms). */
  replace(b: WriteBundle): void {
    const rest = this.waiting().filter((x) => x.id !== b.id);
    this.waiting.set(b.state === 'WAITING' ? [...rest, b].sort((x, y) => x.createdAt.localeCompare(y.createdAt)) : rest);
    const p = this.partial().filter((x) => x.id !== b.id);
    this.partial.set(b.state === 'PARTIAL' ? [b, ...p] : p);
    const e = this.ended().filter((x) => x.id !== b.id);
    this.ended.set(b.state === 'DONE' || b.state === 'REJECTED' ? [b, ...e] : e);
  }

  /** "(3) ⇪2 Alfred": after any count another part of the page leads with, so neither wipes the other. */
  private title(n: number): void {
    if (typeof document === 'undefined') return;
    const t = document.title;
    const m = /^(\([^)]*\)\s)?(⇪\d+\s)?(.*)$/s.exec(t);
    if (!m) return;
    const want = `${m[1] ?? ''}${n ? `⇪${n} ` : ''}${m[3]}`;
    if (want !== t) document.title = want;
  }
}
