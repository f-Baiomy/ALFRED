import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { LiveWork } from '../../../core/models/board.models';
import { LiveWorkStateService, liveDuration } from '../../../core/state/live-work-state.service';

/**
 * /alfred-live working on a card, in its drawer (docs/board.md "Live answers"): while it runs, the heading ("✦ Claude
 * is acting on your answer"), every step as it happens, the reply typing in and Stop; once it ended, one folded line
 * ("✦ 6 s · 4 steps ▸") that opens to the same steps. The reply itself is the card's ordinary comment above.
 */
@Component({
  selector: 'app-live-work-box',
  standalone: true,
  template: `
    @if (work(); as w) {
      @if (w.state === 'WORKING' && compact()) {
        <!-- A chat answer arrives as its own message: here only where Claude is, never the draft. -->
        <div class="live-line" role="status" aria-live="polite">
          <span class="live-spinner"></span>
          <span class="live-now">{{ nowStep() }}</span>
          @if (w.steps.length > 1) { <span class="live-count">step {{ w.steps.length }}</span> }
          <span class="live-time">{{ elapsed() }}</span>
          @if (editable()) {
            <button type="button" class="board-link" [disabled]="w.stop" (click)="state.stop(w.id)">{{ w.stop ? 'stopping…' : 'Stop' }}</button>
          }
        </div>
      } @else if (w.state === 'WORKING') {
        <div class="live-box" role="status" aria-live="polite">
          <div class="live-head"><span class="live-spinner"></span>✦ Claude is {{ w.head }}
            <span class="live-time">{{ elapsed() }}</span>
            @if (editable()) {
              <button type="button" class="board-link" [disabled]="w.stop" (click)="state.stop(w.id)">{{ w.stop ? 'stopping…' : 'Stop' }}</button>
            }
          </div>
          @for (s of w.steps; track $index; let last = $last) {
            <div class="live-step" [class.now]="last && !w.draft"><span class="live-mk">{{ last && !w.draft ? '›' : '✓' }}</span>{{ s }}</div>
          }
          @if (!w.steps.length) { <div class="live-step now"><span class="live-mk">›</span>reading the card</div> }
          @if (w.draft) { <div class="live-draft">{{ w.draft }}<span class="live-caret"></span></div> }
        </div>
      } @else {
        <div class="live-done" [class.failed]="w.state === 'FAILED'">
          <button type="button" class="live-fold" (click)="open.set(!open())">
            ✦ {{ w.state === 'FAILED' ? 'Claude could not finish' : w.state === 'STOPPED' ? 'Stopped' : 'Claude' }} · {{ elapsed() }} ·
            {{ w.steps.length }} step{{ w.steps.length === 1 ? '' : 's' }} {{ open() ? '▾' : '▸' }}</button>
          @if (w.outcome) { <span class="board-dim">{{ w.outcome }}</span> }
          @if (open()) {
            @for (s of w.steps; track $index) { <div class="live-step"><span class="live-mk">✓</span>{{ s }}</div> }
          }
        </div>
      }
    }`,
})
export class LiveWorkBoxComponent implements OnDestroy {
  readonly state = inject(LiveWorkStateService);
  readonly project = input.required<string>();
  readonly number = input(0);
  /** A chat message's run (specs/022) instead of a card's. */
  readonly chatMessageId = input<number | null>(null);
  readonly editable = input(true);
  /** One line - what Claude is doing now - instead of every step and the reply typing in (the chat). */
  readonly compact = input(false);

  readonly open = signal(false);
  /** The step Claude is on, as a sentence. */
  readonly nowStep = computed(() => {
    const steps = this.work()?.steps ?? [];
    const last = steps.length ? steps[steps.length - 1] : this.chatMessageId() != null ? 'reading your message' : 'reading the card';
    return last.charAt(0).toUpperCase() + last.slice(1) + '…';
  });
  private readonly now = signal(Date.now());
  private tick: ReturnType<typeof setInterval> | null = null;

  readonly work = computed<LiveWork | null>(() => {
    this.state.all();
    const chat = this.chatMessageId();
    return chat != null ? this.state.forChatMessage(chat, this.now()) : this.state.forCard(this.project(), this.number(), this.now());
  });
  readonly elapsed = computed(() => {
    const w = this.work();
    return w ? liveDuration(w, this.now()) : '';
  });

  constructor() {
    // The seconds count up only while Claude works - one clock, gone the moment it ends.
    effect(() => {
      const working = this.work()?.state === 'WORKING';
      if (working && !this.tick) this.tick = setInterval(() => this.now.set(Date.now()), 1000);
      if (!working && this.tick) {
        clearInterval(this.tick);
        this.tick = null;
      }
    }, { allowSignalWrites: true });
  }

  ngOnDestroy(): void {
    if (this.tick) clearInterval(this.tick);
  }
}
