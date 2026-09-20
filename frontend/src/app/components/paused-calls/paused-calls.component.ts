import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { PauseDecision, PausedCall } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';

type Tab = 'response' | 'request' | 'headers';

/**
 * The breakpoint inspector: calls the proxy is holding open while somebody decides what happens to
 * them.
 *
 * The thing to keep in mind when changing anything here is that every row on this screen is a real
 * client socket held open right now. That is why the countdown is prominent rather than tucked into
 * a corner, why "send unchanged" is as easy to reach as "send edited", and why the component keeps
 * a local 1-second ticker: the deadline is real and a stale timer would misrepresent how long is
 * left to decide.
 *
 * The ticker is the one timer in the app and it is not polling - it re-renders a countdown from
 * data already in hand and makes no requests. The list itself still arrives by WebSocket push, like
 * everything else (see docs/frontend-architecture.md).
 */
@Component({
  selector: 'app-paused-calls',
  standalone: true,
  templateUrl: './paused-calls.component.html',
})
export class PausedCallsComponent {
  readonly state = inject(InterceptionStateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly selectedId = signal<string | null>(null);
  readonly tab = signal<Tab>('response');

  /** Re-read every second so the countdown moves; holds no data of its own. */
  private readonly tick = signal(Date.now());

  /** The body as the user has edited it, or null while it is still exactly what came back. */
  readonly editedBody = signal<string | null>(null);
  readonly editedStatus = signal<number | null>(null);
  readonly busy = signal(false);

  readonly selected = computed<PausedCall | null>(() => {
    const calls = this.state.pausedCalls();
    if (calls.length === 0) return null;
    return calls.find((c) => c.callId === this.selectedId()) ?? calls[0];
  });

  /** Which half the user is deciding about: a response breakpoint edits the response, a request breakpoint the request. */
  readonly editableHttp = computed(() => {
    const call = this.selected();
    if (!call) return null;
    return call.phase === 'response' ? call.response ?? null : call.request ?? null;
  });

  readonly originalBody = computed(() => this.editableHttp()?.body ?? '');
  readonly originalStatus = computed(() => this.editableHttp()?.status ?? null);

  readonly currentBody = computed(() => this.editedBody() ?? this.originalBody());
  readonly currentStatus = computed(() => this.editedStatus() ?? this.originalStatus());

  readonly dirty = computed(
    () =>
      (this.editedBody() !== null && this.editedBody() !== this.originalBody()) ||
      (this.editedStatus() !== null && this.editedStatus() !== this.originalStatus())
  );

  readonly headerRows = computed(() => {
    const headers = this.editableHttp()?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
  });

  readonly requestHeaderRows = computed(() => {
    const headers = this.selected()?.request?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
  });

  constructor() {
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.tick.set(Date.now()));

    // Selecting a different call must drop any half-finished edit, or a body typed for one call
    // would be released against another.
    effect(
      () => {
        this.selected();
        this.editedBody.set(null);
        this.editedStatus.set(null);
      },
      { allowSignalWrites: true }
    );
  }

  select(call: PausedCall): void {
    this.selectedId.set(call.callId);
    this.tab.set(call.phase === 'response' ? 'response' : 'request');
  }

  /**
   * Editing anything implies you are at the screen, so the clock stops on first keystroke rather
   * than waiting for the button to be pressed - a body edited under a running countdown is the
   * exact case this feature exists to prevent.
   */
  private claimOnEdit(): void {
    const call = this.selected();
    if (call && !this.held(call)) this.takeControl(call);
  }

  isSelected(call: PausedCall): boolean {
    return this.selected()?.callId === call.callId;
  }

  /**
   * Whole seconds left before the proxy gives up and applies the rule's own timeout action.
   *
   * Only meaningful while the call is merely paused: the countdown is a grace period for somebody
   * to NOTICE it, and once control has been taken it stops entirely (see held/heldFor).
   */
  secondsLeft(call: PausedCall): number {
    const remaining = call.pausedAt + call.timeoutSeconds * 1000 - this.tick();
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  held(call: PausedCall): boolean {
    return call.heldAt != null;
  }

  /** How long a held call has been waiting on you - counts UP, because nothing is expiring. */
  heldFor(call: PausedCall): string {
    const seconds = Math.max(0, Math.floor((this.tick() - (call.heldAt ?? 0)) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  }

  urgent(call: PausedCall): boolean {
    return !this.held(call) && this.secondsLeft(call) <= 10;
  }

  takeControl(call: PausedCall): void {
    if (this.held(call) || this.busy()) return;
    this.busy.set(true);
    this.state.takeControl(call.callId).subscribe({
      next: () => this.busy.set(false),
      error: () => {
        this.busy.set(false);
        this.state.refreshPaused();
      },
    });
  }

  timeoutLabel(call: PausedCall): string {
    return call.onTimeout === 'abort' ? 'aborts' : 'releases unchanged';
  }

  onBodyInput(event: Event): void {
    this.editedBody.set((event.target as HTMLTextAreaElement).value);
    this.claimOnEdit();
  }

  onStatusInput(event: Event): void {
    const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.editedStatus.set(Number.isFinite(parsed) ? parsed : null);
    this.claimOnEdit();
  }

  revert(): void {
    this.editedBody.set(null);
    this.editedStatus.set(null);
  }

  /**
   * A release carries ONLY what was actually changed. Sending the untouched body back would mean
   * the proxy rewrites it - re-serialising a payload that may be megabytes, and turning "send
   * unchanged" into something subtly different from never having paused at all.
   */
  release(edited: boolean): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    const decision: PauseDecision = edited
      ? {
          action: 'release',
          body: this.editedBody() !== null && this.editedBody() !== this.originalBody() ? this.editedBody() : null,
          status:
            this.editedStatus() !== null && this.editedStatus() !== this.originalStatus() ? this.editedStatus() : null,
        }
      : { action: 'release' };
    this.send(call, decision);
  }

  abort(): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    this.send(call, { action: 'abort' });
  }

  releaseAll(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.state.releaseAll().subscribe({
      next: () => this.busy.set(false),
      error: () => this.busy.set(false),
    });
  }

  private send(call: PausedCall, decision: PauseDecision): void {
    this.busy.set(true);
    this.state.decide(call.callId, decision).subscribe({
      next: () => {
        this.busy.set(false);
        this.revert();
      },
      // A 404 means this call stopped waiting while the user was deciding - its timeout fired, or
      // another tab answered it. Refreshing is the whole remedy; there is nothing left to act on.
      error: () => {
        this.busy.set(false);
        this.state.refreshPaused();
      },
    });
  }

  trackByCallId(_: number, call: PausedCall): string {
    return call.callId;
  }
}
