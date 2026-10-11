import { Component, HostListener, inject, input, signal } from '@angular/core';
import { RetestStateService } from '../../../core/state/retest-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';

/**
 * The board's re-test strip (specs/016): the new-build banner after the app restarted, the one-click re-test recording
 * with its steps ticking as their calls arrive, and the report once it was checked.
 */
@Component({
  selector: 'app-retest-strip',
  standalone: true,
  imports: [MarkdownViewComponent],
  template: `
    @if (state.recording(); as rec) {
      <div class="board-retest-strip">
        <div class="board-retest-strip-head">
          <span class="board-rec"></span><b>{{ rec.name }}</b>
          <span class="board-dim">recording since {{ time(rec.startedAt) }} · use the app as the steps say</span>
          <span class="board-retest-strip-acts">
            <span [class.ok]="doneSteps() === state.recordingSteps().length">{{ doneSteps() }} / {{ state.recordingSteps().length }} steps seen</span>
            <button type="button" class="action-btn primary" [disabled]="state.busy()" (click)="state.stopAndCheck()">■ Stop and check</button>
            <button type="button" class="action-btn" [disabled]="state.busy()" (click)="state.cancel()">Cancel</button>
          </span>
        </div>
        @for (s of state.recordingSteps(); track s.text) {
          <div class="board-retest-step">
            <span [class]="s.seen ? 'ok' : 'board-dim'">{{ s.seen ? '✓' : '○' }}</span>
            <span>{{ s.text }}</span>
            @for (n of s.numbers; track n) { <span class="board-retest-num">#{{ n }}</span> }
            <span class="board-retest-step-calls" [class.ok]="s.seen">{{ s.seen ? s.calls + (s.calls === 1 ? ' call' : ' calls') : 'not seen yet' }}</span>
          </div>
        } @empty {
          <div class="board-dim">Waiting for the first call…</div>
        }
      </div>
    } @else if (state.showNewBuild()) {
      <div class="board-retest-strip board-retest-build">
        <div class="board-retest-strip-head">
          <b>⟳ New build{{ project() ? ' of ' + project() : '' }}</b>
          <span class="board-dim">the app started {{ time(state.lastStart()!) }} · {{ state.newBuildCards().length }} Fixed
            {{ state.newBuildCards().length === 1 ? 'card is' : 'cards are' }} ready to re-test</span>
          @if (editable()) {
            <span class="board-retest-strip-acts">
              <button type="button" class="action-btn primary" [disabled]="state.busy()" (click)="state.start(numbers())">▶ Re-test {{ state.newBuildCards().length }}</button>
              <button type="button" class="action-btn" (click)="state.later()">Later</button>
            </span>
          }
        </div>
      </div>
    }
    @if (state.error(); as e) { <div class="board-error" role="alert">{{ e }} <button type="button" class="board-link" (click)="state.error.set(null)">✕</button></div> }
    @if (state.report(); as r) {
      <div class="dialog-backdrop" (click)="state.report.set(null)">
        <div class="dialog-card board-retest-report" role="dialog" aria-label="Re-test report" (click)="$event.stopPropagation()">
          <div class="board-quick-head"><b>Re-test report</b>
            <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="state.report.set(null)">✕</button></div>
          <app-markdown-view [text]="r.markdown" />
          <div class="board-quick-foot">
            <button type="button" class="action-btn primary" (click)="copy(r.markdown)">{{ copied() ? '✓ copied' : '⧉ Copy for the team' }}</button>
            <span class="board-dim">Kept in each card's re-test history.</span>
          </div>
        </div>
      </div>
    }`,
})
export class RetestStripComponent {
  readonly state = inject(RetestStateService);
  readonly project = input('');
  readonly editable = input(true);
  readonly copied = signal(false);

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    if (!this.state.report()) return;
    event.stopImmediatePropagation();
    this.state.report.set(null);
  }

  doneSteps(): number {
    return this.state.recordingSteps().filter((s) => s.seen).length;
  }

  numbers(): number[] {
    return this.state.newBuildCards().map((c) => c.number);
  }

  time(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
