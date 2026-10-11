import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NextSteps } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { skillArg } from '../../../shared/utils/board-skills';
import { copyToClipboard } from '../../../shared/utils/clipboard';

/**
 * One line above the columns (specs/015 FR-3): what waits on the user (oldest first), then what waits on Claude, on a
 * re-test, and in the Inbox - each with the /alfred-* command to paste into Claude Code. Re-read whenever the board's
 * cards are (`version`), never on a timer.
 */
@Component({
  selector: 'app-next-steps-bar',
  standalone: true,
  template: `
    @if (steps(); as s) {
      @if (hasAnything()) {
        <div class="board-next" role="status">
          @if (s.waitingOnUser.length) {
            <span class="board-next-you">⚑ {{ s.waitingOnUser.length }} wait{{ s.waitingOnUser.length === 1 ? 's' : '' }} on you</span>
            @for (w of s.waitingOnUser.slice(0, 6); track w.number) {
              <button type="button" class="board-link" [title]="w.title + ' - ' + why(w.why)" (click)="opened.emit(w.number)">#{{ w.number }}</button>
            }
            @if (s.waitingOnUser.length > 6) { <span class="board-dim">+{{ s.waitingOnUser.length - 6 }}</span> }
            <span class="board-dim">·</span>
          }
          @if (s.toDo + s.inProgress) {
            <span>{{ s.toDo }} To do{{ s.inProgress ? ' · ' + s.inProgress + ' in progress' : '' }}</span>
            <button type="button" class="board-copy" (click)="copy('/alfred-fix')">{{ copied() === '/alfred-fix' ? '✓ copied' : '⧉ /alfred-fix' }}</button>
            <span class="board-dim">·</span>
          }
          @if (s.fixed) {
            <span>{{ s.fixed }} Fixed need a re-test</span>
            <button type="button" class="board-copy" (click)="copy(verifyCmd())">{{ copied() === verifyCmd() ? '✓ copied' : '⧉ /alfred-verify' }}</button>
            <span class="board-dim">·</span>
          }
          @if (s.inbox) {
            <span>{{ s.inbox }} in the Inbox</span>
            <button type="button" class="board-copy" (click)="copy('/alfred-triage')">{{ copied() === '/alfred-triage' ? '✓ copied' : '⧉ /alfred-triage' }}</button>
          }
          <button type="button" class="board-copy board-next-status" title="Ask Claude where everything stands" (click)="copy('/alfred-status')">
            {{ copied() === '/alfred-status' ? '✓ copied' : '⧉ /alfred-status' }}</button>
        </div>
      }
    }`,
})
export class NextStepsBarComponent {
  private readonly api = inject(BoardApiService);
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input<string | null>(null);
  /** Bumped by the board whenever its cards are re-read. */
  readonly version = input<unknown>(null);
  readonly opened = output<number>();

  readonly steps = signal<NextSteps | null>(null);
  readonly copied = signal<string | null>(null);
  readonly hasAnything = computed(() => {
    const s = this.steps();
    return !!s && (s.waitingOnUser.length + s.toDo + s.inProgress + s.fixed + s.inbox) > 0;
  });
  readonly verifyCmd = computed(() => `/alfred-verify ${this.cycleName() ? skillArg(this.cycleName()!) : ''}`.trimEnd());

  constructor() {
    effect(() => {
      const project = this.project();
      const cycleId = this.cycleId();
      this.version();
      untracked(() => this.api.nextSteps(project, cycleId).subscribe({ next: (s) => this.steps.set(s), error: () => this.steps.set(null) }));
    });
  }

  why(w: string): string {
    return w === 'question' ? 'a question waits for your answer' : w === 'proposal' ? 'a proposal waits for Accept / Dismiss'
      : w === 'inbox' ? 'a finding waits to be sorted' : 'waits on you';
  }

  copy(text: string): void {
    void copyToClipboard(text).then(() => {
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }
}
