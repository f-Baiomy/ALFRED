import { Component, computed, inject, input, signal } from '@angular/core';
import { SkillRun } from '../../../core/models/board.models';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { ageText } from '../../../core/models/board.models';
import { failureHint, runDuration } from '../../../shared/utils/skill-prompt';

const SHOWN = 5;

/**
 * The card's runs from the board (docs/board.md "Run from the board"): what was run, on which machine, how long it took
 * and how it ended - each with its steps folded under it, and the user's note. Under the card's activity in the drawer.
 */
@Component({
  selector: 'app-run-history',
  standalone: true,
  template: `
    @if (runs().length) {
      <div class="run-hist">
        <h4>Runs from the board <span class="board-dim">{{ runs().length }}</span></h4>
        @for (r of shown(); track r.id) {
          <div class="run-hist-row" [class]="'run-hist-row run-hist-' + r.state">
            <button type="button" class="board-link run-hist-toggle" [attr.aria-expanded]="open().has(r.id)" (click)="toggle(r.id)">
              {{ open().has(r.id) ? '▾' : '▸' }}</button>
            <span class="run-hist-ico">{{ icon(r) }}</span>
            <code>{{ r.command }}</code>
            <span class="board-dim">· {{ label(r) }} · {{ when(r) }}{{ r.takenBy ? ' · chat on ' + r.takenBy : '' }}</span>
            @if (r.outcome && (r.state === 'DONE' || r.state === 'FAILED')) { <div class="run-hist-out">{{ r.state === 'FAILED' ? hint(r) : r.outcome }}</div> }
            @if (open().has(r.id)) {
              <div class="run-hist-steps">
                @if (r.note) { <div class="run-hist-note">your note: {{ r.note }}</div> }
                @for (s of r.steps; track $index) { <div>· {{ s }}</div> }
                @if (!r.steps.length) { <div class="board-dim">its steps are in the chat</div> }
              </div>
            }
          </div>
        }
        @if (runs().length > SHOWN && !all()) { <button type="button" class="board-link" (click)="all.set(true)">+{{ runs().length - SHOWN }} more</button> }
      </div>
    }`,
})
export class RunHistoryComponent {
  private readonly state = inject(SkillRunsStateService);
  readonly project = input('');
  readonly number = input.required<number>();
  readonly SHOWN = SHOWN;
  readonly open = signal<ReadonlySet<string>>(new Set());
  readonly all = signal(false);
  readonly runs = computed(() => (this.state.projects(), this.state.history(this.project(), this.number())));
  readonly shown = computed(() => (this.all() ? this.runs() : this.runs().slice(0, SHOWN)));

  constructor() {
    queueMicrotask(() => this.state.watch(this.project()));
  }

  toggle(id: string): void {
    const next = new Set(this.open());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.open.set(next);
  }

  icon(r: SkillRun): string {
    return { QUEUED: '◌', SENT: '⏳', RUNNING: '✦', DONE: '✓', FAILED: '✕', STOPPED: '■', CANCELLED: '■' }[r.state];
  }

  label(r: SkillRun): string {
    switch (r.state) {
      case 'QUEUED': return 'sending to the chat';
      case 'SENT': return 'waiting for the chat';
      case 'RUNNING': return `running · ${runDuration(r)}`;
      case 'CANCELLED': return 'cancelled';
      case 'STOPPED': return `stopped · ${runDuration(r)}`;
      case 'FAILED': return `failed · ${runDuration(r)}`;
      default: return runDuration(r);
    }
  }

  when(r: SkillRun): string {
    return `${ageText(r.createdAt, Date.now())} ago`;
  }

  hint(r: SkillRun): string {
    return failureHint(r);
  }
}
