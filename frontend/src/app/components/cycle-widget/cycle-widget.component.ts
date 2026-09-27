import { ChangeDetectionStrategy, Component, ElementRef, Injector, NgZone, OnDestroy, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallRecord } from '../../core/models/call.model';
import { CycleWidgetWindowService } from '../../core/services/cycle-widget-window.service';
import { CycleWidgetStateService, WIDGET_CYCLE_SORTS, WidgetSource } from '../../core/state/cycle-widget-state.service';
import { methodClass, statusClass, supplierOf, uriPath } from '../../shared/utils/call-utils';
import { CwIconComponent } from './cw-icon.component';
import { MiniWaterfallComponent, SpacerRequest } from './mini-waterfall.component';

/** How long a new-call toast stays up, and how long it lingers after the pointer leaves it. */
const TOAST_MS = 3500;
const TOAST_LINGER_MS = 1200;
const FLASH_MS = 900;
/** Calls arriving within this window become ONE Windows notification ("5 new calls in ...") rather than five. */
const OS_NOTIFY_GROUP_MS = 1200;
const OS_NOTIFY_KEY = 'alfred-cycle-widget-os-notify';
/** How often the minimized summary's "last 2 min ago" is re-worded - a display clock, not a data poll. */
const CLOCK_MS = 30_000;

interface ToastView {
  readonly callId: string;
  readonly method: string;
  readonly methodClass: string;
  readonly label: string;
  readonly status: string;
  readonly statusClass: string;
  readonly where: string;
  /** Calls that arrived while this toast was already up - shown as "+N more" instead of stacking toasts. */
  readonly more: number;
  /** Bumped per arrival so the progress bar restarts. */
  readonly seq: number;
}

/**
 * The floating session-cycle widget - rendered by CycleWidgetWindowService into a Picture-in-Picture
 * or popup window, never placed in a page template. Pick a cycle, pause/resume it, create one that
 * starts recording right away, watch its calls as a nested waterfall, choose which sources show,
 * and switch inbound logging per project. A toast announces each new call captured into the
 * selected cycle.
 */
@Component({
  selector: 'app-cycle-widget',
  standalone: true,
  imports: [CwIconComponent, MiniWaterfallComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cycle-widget.component.html',
})
export class CycleWidgetComponent implements OnDestroy {
  readonly state = inject(CycleWidgetStateService);
  readonly win = inject(CycleWidgetWindowService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);

  readonly sourcesOpen = signal(false);
  readonly newName = signal('');
  readonly newError = signal<string | null>(null);
  readonly busy = signal(false);
  /** What's open under the collapsed pill - the window grows to fit it, and shrinks back when it closes. */
  readonly pillPanel = signal<'list' | 'new' | 'spacer' | null>(null);
  readonly cycleSorts = WIDGET_CYCLE_SORTS;
  /** A short confirmation the minimized status line shows in place of its summary ("Spacer added"). */
  readonly statusNote = signal<string | null>(null);
  private statusNoteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pillSpacer = viewChild<ElementRef<HTMLInputElement>>('pillSpacer');
  private readonly pillName = viewChild<ElementRef<HTMLInputElement>>('pillName');

  readonly toast = signal<ToastView | null>(null);
  readonly toastVisible = signal(false);
  readonly flashId = signal<string | null>(null);

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private toastShownAt = 0;

  /** Windows (OS) notifications for captured calls - this widget's own opt-in, separate from the
   * paused-call notifications DesktopNotificationsService drives, so turning one on never turns on the other. */
  readonly osNotifySupported = typeof Notification !== 'undefined';
  readonly osNotify = signal(this.osNotifySupported && Notification.permission === 'granted' && readFlag(OS_NOTIFY_KEY));
  private osPending: { count: number; callId: string } | null = null;
  private osTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly now = signal(Date.now());
  // Outside the zone: a standing interval inside it would keep the app forever "unstable" and run
  // change detection on every tick. The signal still updates the view on its own.
  private readonly clock = inject(NgZone).runOutsideAngular(() => setInterval(() => this.now.set(Date.now()), CLOCK_MS));

  /** The minimized status line when no notification is showing: "Recording · 12 calls · last 2 min ago". */
  readonly idleSummary = computed(() => {
    const note = this.statusNote();
    if (note) return note;
    const cycle = this.cycle();
    if (!cycle) return 'No cycles yet. Press + to create one.';
    const calls = this.state.calls();
    const parts = [cycle.status === 'RECORDING' ? 'Recording' : 'Paused', `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`];
    if (calls.length > 0) {
      const last = Math.max(...calls.map((c) => new Date(c.timestamp).getTime()));
      parts.push(`last ${relativeTime(this.now() - last)}`);
    }
    return parts.join(' · ');
  });

  readonly cycle = this.state.selectedCycle;
  readonly recording = computed(() => this.cycle()?.status === 'RECORDING');

  readonly hiddenCount = computed(() => this.state.sources().filter((s) => this.state.hiddenSources().has(s.key)).length);
  readonly mutedCount = computed(() => this.state.sources().filter((s) => s.loggingEnabled === false).length);
  readonly sourcesSummary = computed(() => {
    const parts = [this.hiddenCount() ? `${this.hiddenCount()} hidden` : '', this.mutedCount() ? `${this.mutedCount()} muted` : ''].filter(Boolean);
    return parts.length ? `Sources · ${parts.join(', ')}` : 'Sources';
  });

  readonly countLabel = computed(() => {
    const total = this.state.calls().length;
    const visible = this.state.visibleCalls().length;
    return visible === total ? `${total} ${total === 1 ? 'call' : 'calls'}` : `${visible} of ${total} calls`;
  });

  readonly emptyText = computed(() => {
    if (this.state.loading()) return 'Loading calls…';
    if (this.state.calls().length > 0) {
      const { bySource, preflights } = this.state.hiddenCounts();
      const parts = [
        preflights ? `${preflights} OPTIONS ${preflights === 1 ? 'preflight' : 'preflights'}` : '',
        bySource ? `${bySource} from hidden sources` : '',
      ].filter(Boolean);
      return `All calls are hidden: ${parts.join(' and ')}.`;
    }
    return this.recording() ? 'Recording. Calls appear here as they arrive.' : 'No calls yet. Resume recording to capture some.';
  });

  constructor() {
    // Sockets and loading run only while a widget window exists. Moving between the PiP and popup
    // windows re-creates this component, which costs one reconnect and reload.
    this.state.activate();
    // Re-fit the collapsed window whenever what's under the pill changes size.
    effect(() => {
      if (!this.win.collapsed()) return;
      this.pillPanel();
      this.newError();
      this.win.notice();
      void this.state.cycles().length;
      afterNextRender(() => this.fitCollapsedWindow(), { injector: this.injector });
    });
    // The side tab in the Alfred tab shows a dot while this is recording.
    effect(() => this.win.recording.set(this.recording()), { allowSignalWrites: true });
    // Every arrival, in order - see CycleWidgetStateService.arrivals$ for why this isn't a signal.
    this.state.arrivals$
      .pipe(takeUntilDestroyed())
      .subscribe((arrival) => (arrival.isNew ? this.announce(arrival.call, arrival.seq) : this.refreshToast(arrival.call)));
  }

  ngOnDestroy(): void {
    this.state.deactivate();
    this.clearTimer('toast');
    this.clearTimer('flash');
    if (this.osTimer) clearTimeout(this.osTimer);
    clearInterval(this.clock);
    if (this.statusNoteTimer) clearTimeout(this.statusNoteTimer);
  }

  // ---- cycles ----

  pick(id: string): void {
    this.state.select(id);
    this.pillPanel.set(null);
  }

  toggleRecording(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.state.toggleRecording().subscribe({
      next: () => this.busy.set(false),
      error: () => {
        this.busy.set(false);
        this.state.error.set("Couldn't change recording. Try again.");
      },
    });
  }

  onNameInput(value: string): void {
    this.newName.set(value);
    this.newError.set(null);
  }

  createCycle(): void {
    const name = this.newName().trim();
    if (!name) {
      this.newError.set('Enter a cycle name');
      return;
    }
    if (this.busy()) return;
    this.busy.set(true);
    this.state.createAndRecord(name).subscribe({
      next: () => {
        this.busy.set(false);
        this.newName.set('');
        this.pillPanel.set(null);
      },
      error: () => {
        this.busy.set(false);
        this.newError.set("Couldn't create the cycle. Try again.");
      },
    });
  }

  // ---- header panels, expand/minimize ----

  togglePillPanel(panel: 'list' | 'new' | 'spacer'): void {
    const next = this.pillPanel() === panel ? null : panel;
    this.pillPanel.set(next);
    this.newError.set(null);
    this.sourcesOpen.set(false);
    if (next === 'new') afterNextRender(() => this.pillName()?.nativeElement.focus(), { injector: this.injector });
    if (next === 'spacer') afterNextRender(() => this.pillSpacer()?.nativeElement.focus(), { injector: this.injector });
  }

  // ---- spacers ----

  /** The pill's spacer: after the latest call, so it marks "now" while recording. */
  addSpacerFromPill(value: string): void {
    const label = value.trim();
    if (!label) {
      this.newError.set('Enter a spacer label');
      return;
    }
    this.addSpacer({ label, anchor: this.state.latestAnchor() });
  }

  addSpacer(request: SpacerRequest): void {
    this.state.addSpacer(request.label, request.anchor).subscribe({
      next: () => {
        this.pillPanel.set(null);
        this.newError.set(null);
        this.flashStatus(`Spacer "${request.label}" added`);
      },
      error: () => this.newError.set("Couldn't add the spacer. Try again."),
    });
  }

  showCallInCycle(call: CallRecord): void {
    const id = this.cycle()?.id;
    if (id) this.win.showCallInCycle(id, call);
  }

  private flashStatus(note: string): void {
    this.statusNote.set(note);
    if (this.statusNoteTimer) clearTimeout(this.statusNoteTimer);
    this.statusNoteTimer = setTimeout(() => this.statusNote.set(null), 2500);
  }

  closePillPanel(): void {
    this.pillPanel.set(null);
    this.newError.set(null);
  }

  /** The window grows straight down in one step (same width both states); the body then fades in - see .cw-body in _cycle-widget.scss. */
  expand(): void {
    this.pillPanel.set(null);
    this.win.setCollapsed(false);
  }

  /** Instant - no fade-out delay before the window shrinks back to the pill. */
  collapse(): void {
    this.pillPanel.set(null);
    this.sourcesOpen.set(false);
    this.win.setCollapsed(true);
  }

  private fitCollapsedWindow(): void {
    const wrap = (this.host.nativeElement as HTMLElement).querySelector('.cw-pill-wrap') as HTMLElement | null;
    // Rounded up: a fractional height rounded down leaves a 1px scrollbar.
    if (wrap) this.win.fitCollapsedHeight(Math.ceil(wrap.getBoundingClientRect().height));
  }

  // ---- sources ----

  toggleSourcesPanel(): void {
    this.sourcesOpen.set(!this.sourcesOpen());
    this.pillPanel.set(null);
  }

  toggleLogging(source: WidgetSource): void {
    if (source.loggingEnabled == null) return;
    this.state.setLogging(source.key, !source.loggingEnabled);
  }

  // ---- window ----

  togglePinned(): void {
    void this.win.setPinned(!this.win.pinned());
  }

  showInAlfred(): void {
    const id = this.cycle()?.id;
    if (id) this.win.showInAlfred(id);
  }

  // ---- toast ----

  pauseToast(): void {
    this.clearTimer('toast');
  }

  resumeToast(): void {
    if (this.toastVisible()) this.scheduleHide(TOAST_LINGER_MS);
  }

  dismissToast(): void {
    this.clearTimer('toast');
    this.toastVisible.set(false);
  }

  /** Clicking the minimized pill's notification opens the widget to show it. */
  openFromNotification(): void {
    this.dismissToast();
    this.expand();
  }

  // ---- Windows notifications ----

  async toggleOsNotify(): Promise<void> {
    if (this.osNotify()) {
      this.osNotify.set(false);
      writeFlag(OS_NOTIFY_KEY, false);
      return;
    }
    if (!this.osNotifySupported) return;
    // From the click, so the browser is willing to ask.
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') {
      this.state.error.set("Windows notifications are blocked for this site. Allow them in the browser's site settings.");
      return;
    }
    this.osNotify.set(true);
    writeFlag(OS_NOTIFY_KEY, true);
  }

  /** Groups calls arriving close together into one notification, sent when the group's window closes. */
  private queueOsNotification(call: CallRecord): void {
    if (!this.osNotify()) return;
    // Nobody needs Windows to announce a call while they're looking at the widget itself.
    if ((this.host.nativeElement as HTMLElement).ownerDocument.hasFocus()) return;
    this.osPending = { count: (this.osPending?.count ?? 0) + 1, callId: call.id };
    this.osTimer ??= setTimeout(() => this.flushOsNotification(), OS_NOTIFY_GROUP_MS);
  }

  private flushOsNotification(): void {
    this.osTimer = null;
    const pending = this.osPending;
    this.osPending = null;
    if (!pending || !this.osNotify()) return;
    // Looked up now rather than kept from arrival, so a call that has resolved since shows its status.
    const call = this.state.calls().find((c) => c.id === pending.callId);
    const cycleName = this.cycle()?.name ?? 'your cycle';
    const title = pending.count === 1 ? `New call in ${cycleName}` : `${pending.count} new calls in ${cycleName}`;
    const body = call ? `${pending.count > 1 ? 'Latest: ' : ''}${call.method} ${labelOf(call)} · ${statusOf(call).status}` : undefined;
    try {
      const n = new Notification(title, { body, tag: 'alfred-cycle-widget' });
      const view = (this.host.nativeElement as HTMLElement).ownerDocument.defaultView;
      n.onclick = () => view?.focus();
    } catch {
      // Some platforms only allow notifications from a service worker - the in-widget notification still shows.
    }
  }

  /** The same notification feeds both states: the toast when expanded, the pill itself when minimized. */
  /** The empty waterfall's one-click fix for whatever is hiding the calls. */
  readonly emptyAction = computed(() => {
    if (this.state.calls().length === 0 || this.state.visibleCalls().length > 0) return null;
    return this.state.hiddenCounts().preflights > 0 ? 'Show OPTIONS' : 'Show all sources';
  });

  onEmptyAction(): void {
    const { bySource, preflights } = this.state.hiddenCounts();
    if (preflights > 0) this.state.setShowOptionsCalls(true);
    if (bySource > 0) this.state.showAll();
  }

  private announce(call: CallRecord, seq: number): void {
    this.flashId.set(call.id);
    this.clearTimer('flash');
    this.flashTimer = setTimeout(() => this.flashId.set(null), FLASH_MS);
    this.queueOsNotification(call);

    // A burst folds into the toast already on screen rather than replacing it every few ms.
    const current = this.toast();
    const burst = this.toastVisible() && current !== null && Date.now() - this.toastShownAt < TOAST_MS;
    this.toast.set({
      callId: call.id,
      method: call.method,
      methodClass: methodClass(call.method),
      label: labelOf(call),
      ...statusOf(call),
      where: this.whereOf(call),
      more: burst ? current.more + 1 : 0,
      seq,
    });
    this.toastShownAt = Date.now();
    this.now.set(this.toastShownAt);
    this.toastVisible.set(true);
    this.scheduleHide(TOAST_MS);
  }

  /** The resolved half of a call already on the toast: fill in its status, without restarting the countdown. */
  private refreshToast(call: CallRecord): void {
    const current = this.toast();
    if (!current || current.callId !== call.id) return;
    this.toast.set({ ...current, ...statusOf(call), where: this.whereOf(call) });
  }

  private whereOf(call: CallRecord): string {
    const info = this.state.depths().get(call.id);
    if (!info?.parentId) return 'new root call';
    const parent = this.state.calls().find((c) => c.id === info.parentId);
    return parent ? `inside ${parent.method} ${labelOf(parent)} · level ${info.depth + 1}` : `level ${info.depth + 1}`;
  }

  private scheduleHide(ms: number): void {
    this.clearTimer('toast');
    this.toastTimer = setTimeout(() => this.toastVisible.set(false), ms);
  }

  private clearTimer(which: 'toast' | 'flash'): void {
    const timer = which === 'toast' ? this.toastTimer : this.flashTimer;
    if (timer) clearTimeout(timer);
    if (which === 'toast') this.toastTimer = null;
    else this.flashTimer = null;
  }
}

export function relativeTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private browsing / quota - the choice still holds for this session.
  }
}

function statusOf(call: CallRecord): { status: string; statusClass: string } {
  if (call.state === 'IN_PROGRESS') return { status: '…', statusClass: '' };
  const status = call.response?.status ?? null;
  return { status: status != null ? String(status) : 'ERR', statusClass: statusClass(status) };
}

function labelOf(call: CallRecord): string {
  const path = uriPath(call.url);
  return call.source === 'internal' ? `${call.service_name ?? 'unknown'} /${path}` : `${supplierOf(call)}/${path}`;
}
