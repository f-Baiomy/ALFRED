import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { PauseDecision, PausedCall } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { StatusPickerComponent } from '../status-picker/status-picker.component';

/** One editable header row. `removed` keeps the row on screen, struck through, rather than vanishing. */
export interface EditableHeader {
  name: string;
  value: string;
  removed: boolean;
  /** Added by hand rather than sent by the client or the host. */
  added: boolean;
}

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
  imports: [StatusPickerComponent],
  templateUrl: './paused-calls.component.html',
})
export class PausedCallsComponent {
  readonly state = inject(InterceptionStateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly selectedId = signal<string | null>(null);
  readonly tab = signal<Tab>('response');

  /** Re-read every second so the countdown moves; holds no data of its own. */
  private readonly tick = signal(Date.now());

  /** Which call the current edits belong to - see the effect in the constructor. */
  private editingCallId: string | null = null;

  /** The body as the user has edited it, or null while it is still exactly what came back. */
  readonly editedBody = signal<string | null>(null);
  readonly editedStatus = signal<number | null>(null);
  /** Null while the headers are untouched - the same "only send what changed" rule as the body. */
  readonly editedHeaders = signal<EditableHeader[] | null>(null);
  readonly busy = signal(false);

  /** The paste-everything box, open only while it is being used. */
  readonly replaceOpen = signal(false);
  readonly replaceText = signal('');
  readonly replaceError = signal<string | null>(null);

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
      (this.editedStatus() !== null && this.editedStatus() !== this.originalStatus()) ||
      this.headerChangeCount() > 0
  );

  /** The header rows as they stand - the call's own, or the working copy once anything is edited. */
  readonly headerRows = computed<EditableHeader[]>(() => {
    const edited = this.editedHeaders();
    if (edited) return edited;
    const headers = this.editableHttp()?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value, removed: false, added: false }));
  });

  /**
   * What to actually send: only the headers that differ from what arrived.
   *
   * A null VALUE removes that header - the wire contract apply_decision already implements - and
   * an absent key leaves it alone. Sending the whole set every time would rewrite forty headers
   * to change one, and would stop an untouched release being byte-identical to never pausing.
   */
  readonly headerChanges = computed<Record<string, string | null>>(() => {
    const edited = this.editedHeaders();
    if (!edited) return {};
    const original = this.editableHttp()?.headers ?? {};
    const changes: Record<string, string | null> = {};
    for (const row of edited) {
      if (!row.name.trim()) continue;
      if (row.removed) {
        if (row.name in original) changes[row.name] = null;
      } else if (original[row.name] !== row.value) {
        changes[row.name] = row.value;
      }
    }
    // A header that was in the original and is no longer in the list at all was deleted outright.
    const kept = new Set(edited.filter((r) => !r.removed).map((r) => r.name));
    for (const name of Object.keys(original)) {
      if (!kept.has(name)) changes[name] = null;
    }
    return changes;
  });

  readonly headerChangeCount = computed(() => Object.keys(this.headerChanges()).length);

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
    //
    // Keyed on the call ID, NOT the object. The list is re-fetched whenever anything about a
    // paused call changes - including when editing claims it - so the same call arrives as a new
    // object seconds after you start typing. Watching identity meant the FIRST edit to an
    // unclaimed call was always thrown away: the edit triggered the claim, the claim refreshed
    // the list, and the refresh wiped the edit. Caught on live traffic, where a header change
    // vanished and only the second one survived.
    effect(
      () => {
        const id = this.selected()?.callId ?? null;
        if (id === this.editingCallId) return;
        this.editingCallId = id;
        this.editedBody.set(null);
        this.editedStatus.set(null);
        this.editedHeaders.set(null);
        this.replaceOpen.set(false);
        this.replaceText.set('');
        this.replaceError.set(null);
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

  onStatusChange(status: number): void {
    this.editedStatus.set(status);
    this.claimOnEdit();
  }

  /** Starts a working copy on first edit, so an untouched call still sends nothing. */
  private workingHeaders(): EditableHeader[] {
    const existing = this.editedHeaders();
    if (existing) return existing;
    const headers = this.editableHttp()?.headers ?? {};
    return Object.entries(headers).map(([name, value]) => ({ name, value, removed: false, added: false }));
  }

  onHeaderName(index: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.editedHeaders.set(this.workingHeaders().map((row, i) => (i === index ? { ...row, name } : row)));
    this.claimOnEdit();
  }

  onHeaderValue(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editedHeaders.set(this.workingHeaders().map((row, i) => (i === index ? { ...row, value } : row)));
    this.claimOnEdit();
  }

  /**
   * Removing keeps the row, struck through and undoable. A row that simply vanished would leave
   * "did I delete content-type, or was it never there" unanswerable on a call being held open.
   */
  toggleHeaderRemoved(index: number): void {
    this.editedHeaders.set(
      this.workingHeaders()
        .map((row, i) => (i === index ? { ...row, removed: !row.removed } : row))
        // A row added by hand and then removed never existed, so it goes entirely.
        .filter((row) => !(row.added && row.removed))
    );
    this.claimOnEdit();
  }

  addHeader(): void {
    this.editedHeaders.set([...this.workingHeaders(), { name: '', value: '', removed: false, added: true }]);
    this.claimOnEdit();
  }

  toggleReplace(): void {
    const opening = !this.replaceOpen();
    if (opening) {
      // Seeded with what is actually there, so "replace everything" starts from the truth rather
      // than an empty box somebody has to reconstruct a live call inside.
      this.replaceText.set(
        JSON.stringify(
          {
            ...(this.selected()?.phase === 'response' ? { status: this.currentStatus() } : {}),
            headers: Object.fromEntries(
              this.headerRows().filter((r) => !r.removed).map((r) => [r.name, r.value])
            ),
            body: this.currentBody(),
          },
          null,
          2
        )
      );
      this.replaceError.set(null);
    }
    this.replaceOpen.set(opening);
  }

  onReplaceText(event: Event): void {
    this.replaceText.set((event.target as HTMLTextAreaElement).value);
    this.replaceError.set(null);
  }

  /**
   * Applies a pasted {status, headers, body} wholesale. Anything left out of `headers` is
   * REMOVED rather than kept - a "replace everything" that quietly preserved what you deleted is
   * the one thing this control must not do.
   */
  applyReplacement(): void {
    let parsed: { status?: unknown; headers?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(this.replaceText()) as typeof parsed;
    } catch (e) {
      this.replaceError.set(`That is not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.replaceError.set('Expected an object with status, headers and body.');
      return;
    }

    const headers = parsed.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
      this.replaceError.set('headers must be an object of name to value.');
      return;
    }

    if (headers !== undefined) {
      const original = this.editableHttp()?.headers ?? {};
      const replacement: EditableHeader[] = Object.entries(headers as Record<string, unknown>).map(
        ([name, value]) => ({ name, value: String(value), removed: false, added: !(name in original) })
      );
      // Everything the paste left out is explicitly gone, not quietly kept.
      const kept = new Set(replacement.map((r) => r.name));
      for (const [name, value] of Object.entries(original)) {
        if (!kept.has(name)) replacement.push({ name, value, removed: true, added: false });
      }
      this.editedHeaders.set(replacement);
    }

    if (typeof parsed.body === 'string') this.editedBody.set(parsed.body);
    if (typeof parsed.status === 'number') this.editedStatus.set(parsed.status);

    this.replaceOpen.set(false);
    this.claimOnEdit();
  }

  revert(): void {
    this.editedBody.set(null);
    this.editedStatus.set(null);
    this.editedHeaders.set(null);
    this.replaceOpen.set(false);
    this.replaceError.set(null);
  }

  /**
   * A release carries ONLY what was actually changed. Sending the untouched body back would mean
   * the proxy rewrites it - re-serialising a payload that may be megabytes, and turning "send
   * unchanged" into something subtly different from never having paused at all.
   */
  release(edited: boolean): void {
    const call = this.selected();
    if (!call || this.busy()) return;
    const headers = this.headerChanges();
    const decision: PauseDecision = edited
      ? {
          action: 'release',
          headers: Object.keys(headers).length > 0 ? headers : null,
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
