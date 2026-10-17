import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { switchMap } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { MainSummary } from '../../../core/team/team.models';

/**
 * The board's main work item (specs/028 US2, was 027's linked item), on the board's Task tab: its chip, "<tracker>
 * changed" when the last sync found it changed since the saved copy (Review shows before and after; Save adds it to the
 * brief and keeps the new copy, Dismiss just keeps it), and Fetch attachments while a token is live.
 */
@Component({
  selector: 'app-work-item-strip',
  standalone: true,
  template: `
    @if (main(); as l) {
      <div class="wis">
        <a class="tv-chip wis-chip" [href]="l.snapshot['url'] || null" target="_blank" rel="noopener noreferrer" [title]="l.provider + ' work item - the main item of this board'">
          ★ {{ ui().icon }} {{ l.item }} · {{ l.snapshot['type'] }} · {{ l.snapshot['state'] }}</a>
        @if (l.changes.length) {
          <button type="button" class="wis-changed" (click)="reviewing.set(!reviewing())" [attr.aria-expanded]="reviewing()">
            ⚠ {{ ui().label }} changed · {{ l.changes.length }} field{{ l.changes.length === 1 ? '' : 's' }} · Review</button>
        }
        @if (state.hasToken()) {
          <button type="button" class="action-btn" [disabled]="busy() || !editable()" (click)="fetch()">⇩ Fetch attachments</button>
        } @else {
          <span class="wis-dim">Enter a token on the Team tab to fetch its attachments</span>
        }
        @if (message()) { <span class="wis-msg" [class.err]="error()">{{ message() }}</span> }
      </div>
      @if (reviewing() && l.changes.length) {
        <div class="wis-review">
          <table>
            <thead><tr><th>Field</th><th>Saved</th><th>Now</th></tr></thead>
            <tbody>
              @for (c of l.changes; track c.field) {
                <tr><td>{{ c.field }}</td><td class="wis-before">{{ plain(c.from) || '-' }}</td><td class="wis-after">{{ plain(c.to) || '-' }}</td></tr>
              }
            </tbody>
          </table>
          <div class="wis-acts">
            <button type="button" class="action-btn primary" [disabled]="busy() || !editable()" (click)="save(l)"
                    title="Adds what changed to the brief, then keeps the new copy">Save to brief</button>
            <button type="button" class="action-btn" [disabled]="busy() || !editable()" (click)="dismiss(l)">Dismiss</button>
          </div>
        </div>
      }
    }`,
  styles: [`
    .wis { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-top: .3rem; }
    .wis-chip { text-decoration: none; }
    .wis-changed { border: 1px solid var(--amber); color: var(--amber); background: none; border-radius: 6px; padding: .1rem .5rem; cursor: pointer; font-size: .78rem; }
    .wis-dim { color: var(--text-dim); font-size: .76rem; }
    .wis-msg { font-size: .78rem; color: var(--green); }
    .wis-msg.err { color: var(--red); }
    .wis-review { margin: .5rem 0; padding: .5rem; border: 1px solid var(--border-strong); border-radius: 8px; overflow-x: auto; }
    .wis-review table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .wis-review th, .wis-review td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    .wis-before { color: var(--red); white-space: pre-wrap; }
    .wis-after { color: var(--green); white-space: pre-wrap; }
    .wis-acts { display: flex; gap: .4rem; margin-top: .4rem; }
  `],
})
export class WorkItemStripComponent {
  readonly state = inject(TeamStateService);
  private readonly team = inject(TeamApiService);
  private readonly board = inject(BoardApiService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  readonly main = signal<MainSummary | null>(null);
  readonly reviewing = signal(false);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal(false);
  private asked = 0;

  readonly ui = computed(() => {
    const l = this.main();
    const kind = this.state.connections().find((c) => c.id === l?.conn)?.kind ?? '';
    return this.state.uiOf(kind);
  });

  constructor() {
    if (!this.state.loaded()) this.state.load();
    effect(() => {
      const id = this.boardId();
      this.state.startVersion();
      const e = this.state.boardEvent();
      if (e && e.board && e.board !== id) return;
      untracked(() => this.load(id));
    });
  }

  private load(id: string): void {
    const mine = ++this.asked;
    this.team.mainOf(id).subscribe({ next: (l) => mine === this.asked && this.main.set(l), error: () => mine === this.asked && this.main.set(null) });
  }

  private say(m: string | null, err = false): void {
    this.message.set(m);
    this.error.set(err);
  }

  plain(s: string | null): string {
    return s ? s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  /** What changed, as a brief section: each field before and after, nothing cut. */
  section(l: MainSummary): string {
    const lines = l.changes.map((c) => `- **${c.field}**: ${this.plain(c.from) || '-'} → ${this.plain(c.to) || '-'}`);
    return `## Changed in ${this.ui().label} (${new Date().toISOString().slice(0, 10)})\n${lines.join('\n')}`;
  }

  save(l: MainSummary): void {
    this.busy.set(true);
    this.board.brief(this.boardId()).pipe(
      switchMap((b) => this.board.putBrief(this.boardId(), `${b.text.trimEnd()}\n\n${this.section(l)}\n`)),
      switchMap(() => this.team.keep(this.boardId(), l.conn, l.item)),
    ).subscribe({
      next: () => {
        this.busy.set(false);
        this.reviewing.set(false);
        this.say('Added to the brief');
        this.load(this.boardId());
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not save - the board may be read-only from here', true);
      },
    });
  }

  dismiss(l: MainSummary): void {
    this.busy.set(true);
    this.team.keep(this.boardId(), l.conn, l.item).subscribe({
      next: () => {
        this.busy.set(false);
        this.reviewing.set(false);
        this.load(this.boardId());
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not keep the new copy', true);
      },
    });
  }

  fetch(): void {
    this.busy.set(true);
    this.say(null);
    this.team.fetchAttachments(this.boardId()).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.say(`${r.attached.length} attached${r.notAttached.length ? ' · not attached: ' + r.notAttached.join(', ') : ''}`, r.notAttached.length > 0);
      },
      error: (e) => {
        this.busy.set(false);
        if (e?.error?.error === 'TOKEN_MISSING' || e?.error?.error === 'TOKEN_REJECTED') this.state.readToken();
        this.say(e?.error?.message || 'Could not fetch the attachments', true);
      },
    });
  }
}
