import { NgComponentOutlet } from '@angular/common';
import { Component, Type, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { BoardBadge, TeamItemView, TeamRevision } from '../../../core/team/team.models';
import { PersonPillComponent } from '../person-pill/person-pill.component';
import { TeamStartButtonComponent } from '../start-button/start-button.component';
import { RowAction } from '../results-table/results-table.component';

/**
 * One work item read live (specs/028 US1 FR-017..019): every field, its links (click to open), comments, history, and
 * where it sits in Alfred. A state move or a comment from here is the user's own action - it goes to the tracker at once,
 * with the "via Alfred" footer, and is recorded as a done bundle.
 */
@Component({
  selector: 'app-team-item-drawer',
  standalone: true,
  imports: [NgComponentOutlet, FormsModule, PersonPillComponent, TeamStartButtonComponent],
  template: `
    <div class="tid-backdrop" (click)="closed.emit()"></div>
    <aside class="tid" role="dialog" aria-modal="true" [attr.aria-label]="view()?.item?.title ?? itemId()">
      <div class="tid-head">
        <span class="tid-id">{{ state.ui().word('item') }} {{ itemId() }}{{ view() ? ' · ' + view()!.item.type : '' }}</span>
        <span class="tid-grow"></span>
        @if (view()?.item?.url; as u) { <a class="action-btn" [href]="u" target="_blank" rel="noopener noreferrer">Open in {{ state.ui().label }} ↗</a> }
        <button type="button" class="tid-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
      </div>
      @if (error()) { <div class="tid-err" role="alert">{{ error() }}</div> }
      @if (view(); as v) {
        <h3 class="tid-title">{{ v.item.title }}</h3>
        <div class="tid-props">
          <span><b>State</b> {{ v.item.state || '-' }}</span>
          <span><b>Assigned</b> <app-person-pill [person]="v.item.identities['assigned'] ?? null" [personId]="v.item.assignee" [conn]="conn()" /></span>
          <span><b>{{ state.ui().word('area') }}</b> {{ v.item.area || '-' }}</span>
          <span><b>{{ state.ui().word('sprint') }}</b> {{ v.item.sprint || '-' }}</span>
          <span><b>Changed</b> {{ v.item.changedAt?.slice(0, 16)?.replace('T', ' ') || '-' }} @if (v.item.identities['changed']; as p) { · <app-person-pill [person]="p" [conn]="conn()" /> }</span>
        </div>

        <div class="tid-board">
          <span class="tid-badges">
            @for (b of v.boards; track b.boardId) {
              <span class="tid-badge" [class.changed]="b.changed">{{ roleWord(b) }} <b>{{ b.name ?? b.boardId }}</b>{{ b.changed ? ' · changed since the saved copy' : '' }}</span>
            } @empty { <span class="tid-dim">Not on any Alfred board.</span> }
            @for (c of v.cards; track c.cardId) { <span class="tid-badge">▣ card {{ c.cardId }}</span> }
          </span>
          <span class="tid-acts">
            <button type="button" class="action-btn" (click)="action.emit('NEW_CARD')">+ Card</button>
            <button type="button" class="action-btn" (click)="action.emit('LINK_CARD')">Link to card</button>
            <button type="button" class="action-btn" (click)="action.emit('RELATED')">Add to board</button>
            <button type="button" class="action-btn" (click)="action.emit('MAIN')">Make main of…</button>
            <app-team-start-button [item]="v.item" [conn]="conn()" [linkedBoard]="mainBoard()" (changed)="reload()" />
          </span>
        </div>

        <form class="tid-write" (submit)="$event.preventDefault(); send()">
          <label>Move to
            <select [(ngModel)]="newState" name="state" aria-label="New state">
              <option value="">(keep {{ v.item.state }})</option>
              @for (s of statesFor(); track s) { <option [value]="s">{{ s }}</option> }
            </select>
          </label>
          <textarea [(ngModel)]="comment" name="comment" rows="2" placeholder="Comment - posted to the tracker with &quot;via Alfred&quot;"
                    aria-label="Comment"></textarea>
          <button type="submit" class="action-btn primary" [disabled]="(!newState && !comment.trim()) || sending()">{{ sending() ? 'Sending…' : 'Send to ' + state.ui().label }}</button>
          @if (sent()) { <span class="tid-ok">{{ sent() }}</span> }
        </form>

        <div class="tid-tabs" role="tablist">
          @for (t of tabs; track t) {
            <button type="button" role="tab" [class.on]="tab() === t" [attr.aria-selected]="tab() === t" (click)="openTab(t)">{{ t }}{{ count(t) }}</button>
          }
        </div>
        @switch (tab()) {
          @case ('Fields') {
            @for (f of fields(); track f[0]) {
              <div class="tid-field">
                <div class="tid-key">{{ f[0] }}</div>
                @if (renderer(); as r) { <ng-container *ngComponentOutlet="r; inputs: { key: f[0], value: f[1] }" /> }
                @else { <div class="tid-val">{{ plain(f[1]) }}</div> }
              </div>
            } @empty { <div class="tid-empty">No fields</div> }
          }
          @case ('Links') {
            @for (l of v.item.links; track l.kind + l.toId) {
              <button type="button" class="tid-link" (click)="openOther.emit(l.toId)"><b>{{ l.kind }}</b> {{ l.toId }}</button>
            } @empty { <div class="tid-empty">No links</div> }
          }
          @case ('Comments') {
            @for (c of v.comments ?? []; track c.id) {
              <div class="tid-rev">
                <div class="tid-rev-head">{{ c.by || 'someone' }} · {{ c.at?.slice(0, 16)?.replace('T', ' ') }}</div>
                <div class="tid-val">{{ plain(c.text) }}</div>
              </div>
            } @empty { <div class="tid-empty">No comments</div> }
          }
          @case ('History') {
            @for (r of history() ?? []; track r.rev) {
              <div class="tid-rev">
                <div class="tid-rev-head">rev {{ r.rev }} · {{ r.by || 'someone' }} · {{ r.at ? r.at.slice(0, 16).replace('T', ' ') : '' }}</div>
                @for (c of r.changes; track c.field) {
                  <div class="tid-change"><b>{{ c.field }}</b> {{ cut(c.from) || '-' }} → {{ cut(c.to) || '-' }}</div>
                }
              </div>
            } @empty { <div class="tid-empty">{{ history() === null ? 'Loading…' : 'No history' }}</div> }
          }
          @case ('Attachments') {
            @for (a of v.attachments ?? []; track a.name) {
              <a class="tid-link" [href]="api.attachmentUrl(conn(), v.item.extId, a.name)" target="_blank" rel="noopener noreferrer">📎 {{ a.name }} <span class="tid-dim">{{ size(a.size) }}</span></a>
            } @empty { <div class="tid-empty">No attachments</div> }
          }
        }
      } @else if (!error()) {
        <div class="tid-empty">Reading {{ itemId() }} from {{ state.ui().label }}…</div>
      }
    </aside>`,
  styles: [`
    .tid-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.35); }
    .tid { position: fixed; z-index: 51; top: 0; right: 0; bottom: 0; width: min(680px, 100vw); overflow: auto; padding: 1rem;
      background: var(--popover-solid); border-left: 1px solid var(--border-strong); }
    .tid-head { display: flex; gap: .5rem; align-items: center; }
    .tid-id { color: var(--text-dim); font-size: .82rem; }
    .tid-grow { flex: 1; }
    .tid-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 1rem; }
    .tid-err { color: var(--red); font-size: .84rem; margin: .5rem 0; }
    .tid-ok { color: var(--green); font-size: .8rem; }
    .tid-title { margin: .5rem 0; }
    .tid-props { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: .82rem; align-items: center; }
    .tid-props b { color: var(--text-dim); font-weight: 500; margin-right: .2rem; }
    .tid-board { display: grid; gap: .4rem; margin: .6rem 0; padding: .5rem .6rem; border: 1px solid var(--border-strong); border-radius: 7px; font-size: .82rem; }
    .tid-badges, .tid-acts { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
    .tid-badge { padding: 0 .4rem; border-radius: 4px; border: 1px solid var(--border-strong); font-size: .76rem; }
    .tid-badge.changed { color: var(--amber); border-color: var(--amber); }
    .tid-write { display: grid; gap: .35rem; margin: .4rem 0; font-size: .8rem; }
    .tid-write select, .tid-write textarea { padding: .3rem .45rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; font: inherit; }
    .tid-write label { display: flex; gap: .4rem; align-items: center; }
    .tid-write button { justify-self: start; }
    .tid-tabs { display: flex; gap: .3rem; margin: .8rem 0 .5rem; border-bottom: 1px solid var(--border); }
    .tid-tabs button { border: 0; background: none; color: var(--text-dim); padding: .3rem .6rem; cursor: pointer; }
    .tid-tabs button.on { color: var(--text); border-bottom: 2px solid var(--purple-light); }
    .tid-field { margin: .5rem 0; }
    .tid-key { font-size: .74rem; color: var(--text-dim); }
    .tid-val { white-space: pre-wrap; word-break: break-word; font-size: .84rem; }
    .tid-link { display: block; border: 0; background: none; color: inherit; text-align: left; padding: .15rem 0; cursor: pointer; font-size: .82rem; }
    .tid-change { font-size: .82rem; margin: .2rem 0; word-break: break-all; }
    .tid-rev { margin: .5rem 0; padding: .3rem 0; border-bottom: 1px solid var(--border); }
    .tid-rev-head { font-size: .78rem; color: var(--text-dim); }
    .tid-dim { color: var(--text-dim); }
    .tid-empty { color: var(--text-faint); font-size: .82rem; margin: .4rem 0; }
  `],
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class TeamItemDrawerComponent {
  readonly state = inject(TeamStateService);
  readonly api = inject(TeamApiService);

  readonly conn = input.required<string>();
  readonly itemId = input.required<string>();
  readonly closed = output<void>();
  /** Add ▾ from the drawer: the page asks where. */
  readonly action = output<RowAction>();
  /** A linked item clicked. */
  readonly openOther = output<string>();

  readonly tabs = ['Fields', 'Links', 'Comments', 'History', 'Attachments'] as const;
  readonly tab = signal<(typeof this.tabs)[number]>('Fields');
  readonly view = signal<TeamItemView | null>(null);
  readonly history = signal<TeamRevision[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly sending = signal(false);
  readonly sent = signal<string | null>(null);
  readonly renderer = signal<Type<unknown> | null>(null);
  newState = '';
  comment = '';

  readonly fields = computed(() => Object.entries(this.view()?.item.fields ?? {}).filter(([, v]) => v !== null && v !== ''));
  readonly mainBoard = computed(() => this.view()?.boards.find((b) => b.role === 'MAIN')?.boardId ?? null);
  /** The states of this item's type in its project (from the cached lists). */
  readonly statesFor = computed(() => {
    const i = this.view()?.item;
    if (!i) return [];
    return (this.state.lists()?.states ?? []).filter((s) => s.type === i.type && (!i.project || s.project === i.project) && s.name !== i.state)
      .map((s) => s.name);
  });

  constructor() {
    effect(() => {
      const conn = this.conn();
      const id = this.itemId();
      untracked(() => {
        this.view.set(null);
        this.history.set(null);
        this.tab.set('Fields');
        this.load(conn, id);
      });
    });
    effect(() => {
      const load = this.state.ui().loadFieldRenderer;
      untracked(() => {
        if (load) void load().then((c) => this.renderer.set(c), () => this.renderer.set(null));
        else this.renderer.set(null);
      });
    });
    // someone changed this item's board side (a card, a main, a start): read it again
    effect(() => {
      const e = this.state.boardEvent();
      if (e && ['items', 'cards', 'incoming'].includes(e.what) && (e['item'] === undefined || e['item'] === this.itemId())) {
        untracked(() => this.reload());
      }
    });
    effect(() => {
      if (this.state.startVersion()) untracked(() => this.reload());
    });
  }

  private load(conn: string, id: string): void {
    this.error.set(null);
    this.api.item(conn, id).subscribe({
      next: (v) => this.isCurrent(conn, id) && this.view.set(v),
      error: (e) => this.isCurrent(conn, id) && this.error.set(e?.error?.message || `Could not read ${id}`),
    });
  }

  reload(): void {
    this.load(this.conn(), this.itemId());
  }

  private isCurrent(conn: string, id: string): boolean {
    return this.conn() === conn && this.itemId() === id;
  }

  openTab(t: (typeof this.tabs)[number]): void {
    this.tab.set(t);
    if (t === 'History' && this.history() === null) {
      const conn = this.conn();
      const id = this.itemId();
      this.api.item(conn, id, 'history').subscribe({
        next: (v) => this.isCurrent(conn, id) && this.history.set([...(v.history ?? [])].reverse()),
        error: () => this.isCurrent(conn, id) && this.history.set([]),
      });
    }
  }

  count(t: string): string {
    const v = this.view();
    if (!v) return '';
    const n = t === 'Links' ? v.item.links.length : t === 'Comments' ? v.comments?.length : t === 'Attachments' ? v.attachments?.length : undefined;
    return n ? ` (${n})` : '';
  }

  roleWord(b: BoardBadge): string {
    return b.role === 'MAIN' ? '★ main of' : b.role === 'CARD' ? '▣ on a card of' : '∘ related to';
  }

  send(): void {
    const body: { state?: string; comment?: string } = {};
    if (this.newState) body.state = this.newState;
    if (this.comment.trim()) body.comment = this.comment;
    if (!body.state && !body.comment) return;
    this.sending.set(true);
    this.sent.set(null);
    this.api.direct(this.conn(), this.itemId(), body).subscribe({
      next: (b) => {
        this.sending.set(false);
        const failed = b.steps.filter((s) => s.result && !s.result.ok);
        if (failed.length) this.error.set(failed.map((s) => s.result?.message).filter(Boolean).join(' · ') || 'Not everything was sent');
        else this.sent.set(b.state === 'WAITING' ? 'Waiting for the user to approve' : 'Sent');
        this.newState = '';
        this.comment = '';
        this.reload();
      },
      error: (e) => {
        this.sending.set(false);
        this.error.set(e?.error?.message || 'Could not send');
      },
    });
  }

  /** Tracker text is HTML: shown as plain text, never as markup. */
  plain(s: string | null): string {
    if (!s) return '';
    return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  cut(s: string | null): string {
    const p = this.plain(s).replace(/\s+/g, ' ');
    return p.length > 140 ? p.slice(0, 139) + '…' : p;
  }

  size(n: number): string {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  }
}
