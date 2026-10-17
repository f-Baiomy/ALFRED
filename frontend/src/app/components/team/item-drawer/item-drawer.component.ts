import { NgComponentOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamItem, TeamItemDetail, TeamRevision } from '../../../core/team/team.models';

/**
 * One work item (specs/027 US7): every field (with where it goes in a board's seed), its links, its history (read from
 * the cache, fetched with this browser's token when none is cached), and the Alfred board it opened.
 */
@Component({
  selector: 'app-team-item-drawer',
  standalone: true,
  imports: [NgComponentOutlet],
  template: `
    <div class="tid-backdrop" (click)="closed.emit()"></div>
    <aside class="tid" role="dialog" aria-modal="true" [attr.aria-label]="shown().title">
      <div class="tid-head">
        <span class="tid-id">{{ state.ui().word('item') }} {{ shown().extId }} · {{ shown().type }}</span>
        <span class="tid-grow"></span>
        @if (shown().url) { <a class="action-btn" [href]="shown().url" target="_blank" rel="noopener noreferrer">Open in {{ state.ui().label }} ↗</a> }
        <button type="button" class="tid-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
      </div>
      <h3 class="tid-title">{{ shown().title }}</h3>
      <div class="tid-props">
        <span><b>State</b> {{ shown().state || '-' }}</span>
        <span><b>Assigned</b> {{ shown().assignee || '-' }}</span>
        <span><b>{{ state.ui().word('squad') }}</b> {{ shown().squad || '-' }}</span>
        <span><b>{{ state.ui().word('sprint') }}</b> {{ shown().sprint || '-' }}</span>
      </div>
      @if (detail()?.board; as b) {
        <div class="tid-board">▦ This item has an Alfred board. <button type="button" class="action-btn" (click)="openBoard(b)">Open board</button></div>
      }
      <div class="tid-tabs" role="tablist">
        @for (t of tabs; track t) {
          <button type="button" role="tab" [class.on]="tab() === t" (click)="tab.set(t)">{{ t }}</button>
        }
      </div>
      @switch (tab()) {
        @case ('Fields') {
          @for (f of detail()?.fields ?? []; track f.key) {
            <div class="tid-field">
              <div class="tid-key">{{ f.key }} @if (f.mappedTo) { <span class="tid-map" title="Where it goes in a board's seed">→ {{ f.mappedTo.toLowerCase() }}</span> }</div>
              @if (renderer(); as r) { <ng-container *ngComponentOutlet="r; inputs: { key: f.key, value: f.value }" /> }
              @else { <div class="tid-val">{{ f.value }}</div> }
            </div>
          } @empty { <div class="tid-empty">{{ detail() ? 'No fields' : 'Loading…' }}</div> }
        }
        @case ('Links') {
          @for (l of detail()?.links ?? []; track l.kind + l.toId) {
            <div class="tid-link"><b>{{ l.kind }}</b> {{ l.toId }}</div>
          } @empty { <div class="tid-empty">No links</div> }
        }
        @case ('History') {
          @if (historyError()) { <div class="tid-empty">{{ historyError() }}</div> }
          @for (r of history(); track r.rev) {
            <div class="tid-rev">
              <div class="tid-rev-head">rev {{ r.rev }} · {{ r.by || 'someone' }} · {{ r.at ? r.at.slice(0, 16).replace('T', ' ') : '' }}</div>
              @for (c of r.changes; track c.field) {
                <div class="tid-change"><b>{{ c.field }}</b> {{ cut(c.from) || '-' }} → {{ cut(c.to) || '-' }}</div>
              }
            </div>
          } @empty { <div class="tid-empty">{{ historyLoading() ? 'Loading…' : state.hasToken() ? 'No history' : 'Add your token to read the history' }}</div> }
          @if (state.hasToken()) { <button type="button" class="action-btn" (click)="loadHistory(true)">↻ Fetch history</button> }
        }
      }
    </aside>`,
  styles: [`
    .tid-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.35); }
    .tid { position: fixed; z-index: 51; top: 0; right: 0; bottom: 0; width: min(640px, 100vw); overflow: auto; padding: 1rem;
      background: var(--popover-solid); border-left: 1px solid var(--border-strong); }
    .tid-head { display: flex; gap: .5rem; align-items: center; }
    .tid-id { color: var(--text-dim); font-size: .82rem; }
    .tid-grow { flex: 1; }
    .tid-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 1rem; }
    .tid-title { margin: .5rem 0; }
    .tid-props { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: .82rem; }
    .tid-props b { color: var(--text-dim); font-weight: 500; margin-right: .2rem; }
    .tid-board { margin: .6rem 0; padding: .4rem .6rem; border: 1px solid var(--border-strong); border-radius: 7px; font-size: .84rem; }
    .tid-tabs { display: flex; gap: .3rem; margin: .8rem 0 .5rem; border-bottom: 1px solid var(--border); }
    .tid-tabs button { border: 0; background: none; color: var(--text-dim); padding: .3rem .6rem; cursor: pointer; }
    .tid-tabs button.on { color: var(--text); border-bottom: 2px solid var(--purple-light); }
    .tid-field { margin: .5rem 0; }
    .tid-key { font-size: .74rem; color: var(--text-dim); }
    .tid-map { color: var(--purple-light); }
    .tid-val { white-space: pre-wrap; word-break: break-word; font-size: .84rem; }
    .tid-link, .tid-change { font-size: .82rem; margin: .2rem 0; word-break: break-all; }
    .tid-rev { margin: .5rem 0; padding: .3rem 0; border-bottom: 1px solid var(--border); }
    .tid-rev-head { font-size: .78rem; color: var(--text-dim); }
    .tid-empty { color: var(--text-faint); font-size: .82rem; margin: .4rem 0; }
  `],
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class TeamItemDrawerComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly router = inject(Router);

  readonly item = input.required<TeamItem>();
  readonly closed = output<void>();

  readonly tabs = ['Fields', 'Links', 'History'] as const;
  readonly tab = signal<(typeof this.tabs)[number]>('Fields');
  readonly detail = signal<TeamItemDetail | null>(null);
  readonly history = signal<TeamRevision[]>([]);
  readonly historyLoading = signal(false);
  readonly historyError = signal<string | null>(null);
  /** The cached item once read (a change line opens the drawer with only its head). */
  readonly shown = computed(() => this.detail()?.item ?? this.item());
  readonly renderer = computed(() => this.state.ui().fieldRenderer ?? null);

  constructor() {
    effect(() => {
      const i = this.item();
      untracked(() => {
        this.detail.set(null);
        this.history.set([]);
        this.api.item(i.conn, i.extId).subscribe({ next: (d) => this.isCurrent(i) && this.detail.set(d), error: () => undefined });
        this.loadHistory(false);
      });
    });
  }

  loadHistory(fetch: boolean): void {
    const i = this.item();
    this.historyLoading.set(true);
    this.historyError.set(null);
    this.api.revisions(i.conn, i.extId, fetch).subscribe({
      next: (r) => {
        if (!this.isCurrent(i)) return; // another item opened meanwhile
        if (!fetch && !r.length && this.state.hasToken()) return this.loadHistory(true); // nothing cached yet: read it once
        this.history.set(r);
        this.historyLoading.set(false);
      },
      error: (e) => {
        if (!this.isCurrent(i)) return;
        this.historyLoading.set(false);
        this.historyError.set(e?.error?.error === 'NOT_SUPPORTED' ? 'This tracker gives no history' : e?.error?.message || 'Could not read the history');
      },
    });
  }

  private isCurrent(i: TeamItem): boolean {
    const now = this.item();
    return now.conn === i.conn && now.extId === i.extId;
  }

  cut(s: string | null): string {
    if (!s) return '';
    const plain = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.length > 140 ? plain.slice(0, 139) + '…' : plain;
  }

  openBoard(boardId: string): void {
    this.router.navigate(['/board'], { queryParams: { board: boardId } });
  }
}
