import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamSearch, WatchRule } from '../../../core/team/team.models';

/**
 * A board's watch rules (specs/028 US5 FR-065..069): saved searches run when the board opens, on Refresh, on a hook ping
 * and from Claude; each new match lands once in Incoming. A rule is a search body - text, types, area, tags, assigned.
 */
@Component({
  selector: 'app-team-watch-rules',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="twr">
      <h4>Watch rules <span class="twr-dim">{{ rules().length }}</span>
        @if (rules().length) { <button type="button" class="action-btn" [disabled]="!state.hasToken() || running()" (click)="run()">{{ running() ? 'Running…' : 'Run now' }}</button> }</h4>
      @for (r of rules(); track r.id) {
        <div class="twr-row">
          <b>{{ r.name }}</b> <span class="twr-dim">{{ describe(r) }}</span>
          <span class="twr-dim">{{ r.lastRunAt ? 'ran ' + r.lastRunAt.slice(0, 16).replace('T', ' ') + ' · ' + r.lastNew + ' new' : 'not run yet' }}</span>
          @if (editable()) { <button type="button" class="twr-x" title="Delete the rule" (click)="remove(r)">✕</button> }
        </div>
      } @empty { <div class="twr-dim">No rules. A rule offers this board every new item its search finds.</div> }
      @if (editable()) {
        <form class="twr-add" (submit)="$event.preventDefault(); add()">
          <input [(ngModel)]="name" name="name" placeholder="Rule name" required />
          <input [(ngModel)]="text" name="text" placeholder="Text" />
          <input [(ngModel)]="types" name="types" placeholder="Types (comma)" />
          <input [(ngModel)]="area" name="area" placeholder="Area path" />
          <input [(ngModel)]="tags" name="tags" placeholder="Tags (comma)" />
          <button type="submit" class="action-btn" [disabled]="!name.trim() || !(text.trim() || types.trim() || area.trim() || tags.trim())">+ Rule</button>
        </form>
      }
      @if (message()) { <div class="twr-msg" [class.err]="isError()">{{ message() }}</div> }
    </section>`,
  styles: [`
    .twr { margin-top: .6rem; display: grid; gap: .3rem; font-size: .82rem; }
    h4 { margin: 0; display: flex; gap: .4rem; align-items: center; }
    .twr-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; padding: .25rem 0; border-bottom: 1px solid var(--border); }
    .twr-dim { color: var(--text-dim); font-size: .78rem; }
    .twr-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; }
    .twr-add { display: flex; flex-wrap: wrap; gap: .3rem; }
    .twr-add input { flex: 1 1 120px; padding: .25rem .45rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .twr-msg { color: var(--green); }
    .twr-msg.err { color: var(--red); }
  `],
})
export class TeamWatchRulesComponent {
  private readonly api = inject(TeamApiService);
  readonly state = inject(TeamStateService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  readonly rules = signal<WatchRule[]>([]);
  readonly running = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  name = '';
  text = '';
  types = '';
  area = '';
  tags = '';

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => this.load(id));
    });
    effect(() => {
      const e = this.state.boardEvent();
      if (e && e.board === this.boardId() && e.what === 'rules') untracked(() => {
        this.running.set(false);
        this.load(this.boardId());
      });
    });
  }

  private load(id: string): void {
    this.api.rules(id).subscribe({ next: (r) => this.boardId() === id && this.rules.set(r), error: () => this.rules.set([]) });
  }

  private say(m: string, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  describe(r: WatchRule): string {
    try {
      const q = JSON.parse(r.queryJson) as TeamSearch;
      return [q.text && `"${q.text}"`, q.types?.length && q.types.join('/'), q.areas?.length && 'under ' + q.areas.join(', '),
        q.tags?.length && 'tags ' + q.tags.join(', '), q.assigned && 'assigned ' + q.assigned].filter(Boolean).join(' · ');
    } catch {
      return '';
    }
  }

  add(): void {
    const conn = this.state.picked()?.id;
    if (!conn) return;
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const query: TeamSearch = { text: this.text.trim() || null, types: list(this.types), areas: this.area.trim() ? [this.area.trim()] : [],
      tags: list(this.tags), openOnly: true };
    this.api.addRule(this.boardId(), { name: this.name.trim(), conn, query }).subscribe({
      next: () => {
        this.name = this.text = this.types = this.area = this.tags = '';
        this.load(this.boardId());
      },
      error: (e) => this.say(e?.error?.message || 'Could not save the rule', true),
    });
  }

  remove(r: WatchRule): void {
    this.api.deleteRule(this.boardId(), r.id).subscribe({ next: () => this.load(this.boardId()), error: (e) => this.say(e?.error?.message || 'Could not delete it', true) });
  }

  run(): void {
    this.running.set(true);
    this.api.runRules(this.boardId()).subscribe({
      next: (r) => {
        this.running.set(false);
        this.say(`${r.new} new in Incoming`);
      },
      error: (e) => {
        this.running.set(false);
        this.say(e?.error?.message || 'Could not run the rules', true);
      },
    });
  }
}
