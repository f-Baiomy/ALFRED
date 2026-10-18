import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { debounceTime, filter } from 'rxjs';
import { BoardStage, NextSteps } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { BoardBannerService } from '../../../core/state/board-banner.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { MainSummary } from '../../../core/team/team.models';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import { refreshLine } from '../stage-strip/stage-strip.component';

/** The current stage's own count, said in amber on the facts line ("2 Fixed waiting" in Verify). */
export function stageCount(st: BoardStage | null): string | null {
  if (!st) return null;
  const c = st.counts;
  switch (st.stage) {
    case 'TRIAGE': return c.inbox ? `${c.inbox} in the Inbox` : null;
    case 'CODE': return c.toDo + c.inProgress ? `${c.toDo + c.inProgress} To do` : null;
    case 'VERIFY': return c.fixed ? `${c.fixed} Fixed waiting` : c.unmarked ? `${c.unmarked} to mark` : null;
    case 'TEST': return c.untested + c.failing ? `${c.untested + c.failing} to test` : null;
    default: return null;
  }
}

/**
 * The board's facts line under the header (specs/032 T043): the work item's type and state, the cards, what waits on the
 * user (opens the first), the current stage's count - and Azure ▾ with Refresh from Azure, Fetch attachments and Open in
 * Azure. Results go to the board banner. Re-read on the board's socket signals, never on a timer.
 */
@Component({
  selector: 'app-board-facts',
  standalone: true,
  imports: [CloseOnOutsideDirective],
  styles: [`
    .facts { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 8px 0 12px; font-size: 12.5px; color: var(--text-dim); }
    .facts b { color: var(--text); font-weight: 600; }
    .you { border: 0; background: none; padding: 0; font: inherit; color: var(--amber); cursor: pointer; }
    .you:hover { text-decoration: underline; }
    .amber { color: var(--amber); }
    .spacer { flex: 1; }
    .rel { position: relative; }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 70; min-width: 260px; padding: 6px; background: var(--popover-solid);
      border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: 0 14px 34px rgba(0,0,0,.5); }
    .mi { display: flex; flex-direction: column; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--text);
      font: inherit; font-size: 13px; text-align: left; cursor: pointer; text-decoration: none; }
    .mi small { color: var(--text-dim); font-size: 11.5px; }
    .mi:hover:not(:disabled) { background: color-mix(in srgb, var(--purple) 14%, transparent); }
    .mi:disabled { opacity: .55; cursor: default; }
  `],
  template: `
    <div class="facts">
      @if (main(); as m) {
        <span>Work item <b>{{ m.snapshot['type'] || 'item' }}</b>@if (m.snapshot['state']) { · <b>{{ m.snapshot['state'] }}</b> }</span>
        <span aria-hidden="true">·</span>
      }
      <span class="cards">{{ cards() ? cards() + ' card' + (cards() === 1 ? '' : 's') : 'no cards yet' }}</span>
      @if (waiting().length; as n) {
        <span aria-hidden="true">·</span>
        <button type="button" class="you" [title]="'Open #' + waiting()[0] + ' - the first one'" (click)="openFirst()">⚑ {{ n }} wait{{ n === 1 ? 's' : '' }} on you</button>
      }
      @if (count(); as c) { <span aria-hidden="true">·</span><span class="amber">{{ c }}</span> }
      <span class="spacer"></span>
      @if (main(); as m) {
        <span class="rel" [appCloseOnOutside]="open()" (closed)="open.set(false)">
          <button type="button" class="action-btn" [attr.aria-expanded]="open()" (click)="open.set(!open())">Azure ▾</button>
          @if (open()) {
            <div class="menu" role="menu">
              <button type="button" role="menuitem" class="mi" [disabled]="!editable() || refreshing()" (click)="refresh()">
                {{ refreshing() ? 'Refreshing…' : '↻ Refresh from Azure' }}<small>new or changed child items, comments and state</small></button>
              <button type="button" role="menuitem" class="mi" [disabled]="!editable() || fetching()" (click)="fetch()">
                {{ fetching() ? 'Fetching…' : '⇩ Fetch attachments' }}<small>onto the board's files</small></button>
              @if (m.snapshot['url']; as url) {
                <a role="menuitem" class="mi" [href]="url" target="_blank" rel="noopener noreferrer" (click)="open.set(false)">↗ Open {{ ref() }} in Azure</a>
              }
            </div>
          }
        </span>
      }
    </div>`,
})
export class BoardFactsComponent {
  private readonly api = inject(BoardApiService);
  private readonly team = inject(TeamApiService);
  private readonly teamState = inject(TeamStateService);
  private readonly mentions = inject(BoardMentionsService);
  private readonly banner = inject(BoardBannerService);

  readonly project = input('');
  readonly boardId = input.required<string>();
  readonly stage = input<BoardStage | null>(null);
  readonly cards = input(0);
  readonly editable = input(true);

  readonly main = signal<MainSummary | null>(null);
  readonly steps = signal<NextSteps | null>(null);
  readonly open = signal(false);
  readonly refreshing = signal(false);
  readonly fetching = signal(false);
  readonly waiting = computed(() => (this.steps()?.waitingOnUser ?? []).map((w) => w.number));
  readonly count = computed(() => stageCount(this.stage()));
  readonly ref = computed(() => this.stage()?.ref ?? (this.main() ? `AB#${this.main()!.item}` : ''));
  private asked = 0;

  constructor() {
    if (!this.teamState.loaded()) this.teamState.load();
    effect(() => {
      const id = this.boardId();
      this.teamState.startVersion();
      const e = this.teamState.boardEvent();
      if (e && e.board && e.board !== id) return;
      untracked(() => this.load(id));
    });
    const sub = inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && (!e.project || e.project === this.project())),
      debounceTime(400),
    ).subscribe(() => this.loadSteps(this.boardId()));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private load(id: string): void {
    const mine = ++this.asked;
    this.team.mainOf(id).subscribe({ next: (m) => mine === this.asked && this.main.set(m), error: () => mine === this.asked && this.main.set(null) });
    this.loadSteps(id);
  }

  private loadSteps(id: string): void {
    this.api.nextSteps(this.project(), id).subscribe({ next: (s) => this.boardId() === id && this.steps.set(s), error: () => this.steps.set(null) });
  }

  openFirst(): void {
    const n = this.waiting()[0];
    if (n != null) this.mentions.cardToOpen.set({ project: this.project(), number: n });
  }

  refresh(): void {
    this.open.set(false);
    this.refreshing.set(true);
    const board = this.boardId();
    this.team.refresh(board).subscribe({
      next: (r) => {
        this.refreshing.set(false);
        const m = r.mainState;
        const moved = m && (m.fromState !== m.toState || m.fromIteration !== m.toIteration);
        this.banner.show({ boardId: board, key: 'azure', tone: moved ? 'warn' : 'ok', text: `Azure: ${refreshLine(r)}`,
          detail: moved ? `${this.ref()} moved ${m!.fromState} → ${m!.toState}${m!.fromIteration !== m!.toIteration ? ` · iteration ${m!.fromIteration || '-'} → ${m!.toIteration || '-'}` : ''}.`
            + ' On the next Define run Claude proposes what to do with the open cards. You decide.'
            : r.newItems?.length || r.changedItems?.length || r.matches ? 'Define brings them onto the board - it is in Other steps on the Next card.' : null });
        this.load(board);
      },
      error: (e: HttpErrorResponse) => {
        this.refreshing.set(false);
        this.banner.show({ boardId: board, key: 'azure', tone: 'error', text: 'The refresh from Azure failed',
          detail: e?.error?.error === 'TOKEN_MISSING' ? 'Enter your token on the Team tab first.' : (e?.error?.message ?? null) });
      },
    });
  }

  fetch(): void {
    this.open.set(false);
    const board = this.boardId();
    if (!this.teamState.hasToken()) {
      this.banner.show({ boardId: board, key: 'azure', tone: 'warn', text: 'Enter a token on the Team tab', detail: 'Fetching attachments reads Azure with your token.' });
      return;
    }
    this.fetching.set(true);
    this.team.fetchAttachments(board).subscribe({
      next: (r) => {
        this.fetching.set(false);
        this.banner.show({ boardId: board, key: 'azure', tone: r.notAttached.length ? 'warn' : 'ok', text: `${r.attached.length} attachment${r.attached.length === 1 ? '' : 's'} fetched`,
          detail: r.notAttached.length ? `Not attached: ${r.notAttached.join(', ')}` : null });
      },
      error: (e: HttpErrorResponse) => {
        this.fetching.set(false);
        if (e?.error?.error === 'TOKEN_MISSING' || e?.error?.error === 'TOKEN_REJECTED') this.teamState.readToken();
        this.banner.show({ boardId: board, key: 'azure', tone: 'error', text: 'Could not fetch the attachments', detail: e?.error?.message ?? null });
      },
    });
  }
}
