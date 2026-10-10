import { Component, OnDestroy, computed, effect, input, output, signal } from '@angular/core';
import { AgentStatus } from '../../../core/models/board.models';

/** A status not updated for this long reads as "Claude stopped" (the backend reads it the same way). */
export const AGENT_EXPIRY_MS = 10 * 60 * 1000;

/**
 * What Claude is doing on this board (FR-044): watching (with what it checked and added), paused, or stopped - and
 * Pause / Resume / Stop. Driven by /ws/board agent-status messages; one timer to the expiry deadline flips it to
 * "stopped" when Claude goes quiet (a single delay, re-armed per message - not a refresh).
 */
@Component({
  selector: 'app-live-strip',
  standalone: true,
  template: `
    @if (status(); as s) {
      <div class="board-live" [class.paused]="state() === 'PAUSED'" [class.stopped]="state() === 'STOPPED'">
        <span class="board-pulse"></span>
        <b>{{ headline() }}</b>
        <span class="board-dim">checked {{ s.callsChecked }} calls · {{ s.cardsAdded }} cards added · last check {{ time(s.lastCheckAt) }}</span>
        @if (editable()) {
          <span class="board-live-acts">
            @if (state() === 'WATCHING') { <button type="button" class="action-btn" (click)="action.emit('pause')">Pause</button> }
            @if (state() === 'PAUSED') { <button type="button" class="action-btn" (click)="action.emit('resume')">Resume</button> }
            @if (state() !== 'STOPPED') { <button type="button" class="action-btn" (click)="action.emit('stop')">Stop</button> }
          </span>
        }
      </div>
    }`,
})
export class LiveStripComponent implements OnDestroy {
  readonly status = input<AgentStatus | null>(null);
  readonly editable = input(true);
  readonly action = output<'pause' | 'resume' | 'stop'>();

  private readonly expired = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly state = computed(() => {
    const s = this.status();
    if (!s) return 'STOPPED';
    return this.expired() ? 'STOPPED' : s.state;
  });
  readonly headline = computed(() => {
    const where = this.status()?.cycleId ? ` ${this.status()?.cycleId}` : ' this board';
    switch (this.state()) {
      case 'WATCHING': return `✦ Claude is watching${where}`;
      case 'PAUSED': return `✦ Claude paused on${where}`;
      default: return '✦ Claude stopped';
    }
  });

  constructor() {
    effect(() => {
      const s = this.status();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!s) return;
      const left = Date.parse(s.updatedAt) + AGENT_EXPIRY_MS - Date.now();
      this.expired.set(left <= 0);
      if (left > 0) this.timer = setTimeout(() => this.expired.set(true), left);
    }, { allowSignalWrites: true });
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
