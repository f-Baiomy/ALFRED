import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CallRecord } from '../models/call.model';
import { CallRef, PickedCall, refOf, sameRef } from '../models/call-ref.model';

export type PickMode = 'single' | 'multi';

/** What a feature asks for when it starts picking. Plain data only: it is kept in sessionStorage. */
export interface PickRequest {
  /** Who asked - takeResult(requester) hands the result back to that one feature only. */
  readonly requester: string;
  /** Says in the pick bar what the pick is for. */
  readonly title: string;
  readonly mode: PickMode;
  /** Where Return goes, e.g. `/interception`. */
  readonly returnUrl: string;
  /** The Return button's words, e.g. `the rule editor`. */
  readonly returnLabel: string;
  /** Refs that cannot be picked, and why - e.g. calls already in the cycle being added to. */
  readonly refuse?: readonly { readonly ref: CallRef; readonly reason: string }[];
  /** Refuses every call shown from one cycle (cycleId) or from the live log (null) - e.g. the cycle being added to. */
  readonly refuseOrigin?: { readonly cycleId: string | null; readonly reason: string };
  /** Anything the requester needs to put itself back together on return. Must be JSON-safe. */
  readonly resume?: unknown;
}

export interface PickResult {
  /** Empty when the user cancelled. */
  readonly picked: readonly PickedCall[];
  readonly resume: unknown;
}

interface Stored {
  readonly request: PickRequest | null;
  readonly picked: readonly PickedCall[];
  readonly results: Readonly<Record<string, PickResult>>;
}

const STORAGE_KEY = 'alfred_call_picker';

/**
 * Pick a call from anywhere: a feature starts picking, the user moves freely between tabs, every
 * call card shows a Pick button (see PickCallButtonComponent), the pick bar (PickBarComponent,
 * mounted once in the main layout) lists the picks, and Return hands them back.
 *
 * Deliberately knows nothing about any one feature. A requester passes a `resume` blob and reads
 * it back with takeResult, because its own component is usually destroyed while the user is on
 * another route. Kept in sessionStorage so a reload mid-pick does not throw the pick away.
 */
@Injectable({ providedIn: 'root' })
export class CallPickerService {
  private readonly router = inject(Router);

  private readonly state = signal<Stored>(load());

  readonly request = computed(() => this.state().request);
  readonly active = computed(() => this.state().request !== null);
  readonly picked = computed(() => this.state().picked);

  start(request: PickRequest): void {
    this.update({ request, picked: [] });
  }

  isPicked(call: CallRecord, cycleId: string | null): boolean {
    const ref = refOf(call, cycleId);
    return this.picked().some((p) => sameRef(p.ref, ref));
  }

  /** Null when pickable, else the reason shown on the disabled button. */
  refusal(call: CallRecord, cycleId: string | null): string | null {
    const request = this.request();
    if (!request) return null;
    if (request.refuseOrigin && request.refuseOrigin.cycleId === cycleId) return request.refuseOrigin.reason;
    const ref = refOf(call, cycleId);
    return request.refuse?.find((r) => sameRef(r.ref, ref))?.reason ?? null;
  }

  /** Single mode replaces the pick; multi mode adds or removes. */
  toggle(call: CallRecord, cycleId: string | null, originLabel: string): void {
    const request = this.request();
    if (!request || this.refusal(call, cycleId)) return;
    const ref = refOf(call, cycleId);
    const current = this.picked();
    const already = current.some((p) => sameRef(p.ref, ref));
    const entry: PickedCall = { ref, call: summaryOf(call), originLabel };
    const picked = already
      ? current.filter((p) => !sameRef(p.ref, ref))
      : request.mode === 'single'
        ? [entry]
        : [...current, entry];
    this.update({ picked });
  }

  remove(ref: CallRef): void {
    this.update({ picked: this.picked().filter((p) => !sameRef(p.ref, ref)) });
  }

  /**
   * Stops picking and goes back with NO picks - but still with `resume`, so a requester that parked
   * unsaved work (the rule editor) gets it back either way. Cancelling must never cost an edit.
   */
  cancel(): void {
    this.end([]);
  }

  /** Parks the picks for the requester and goes back. */
  finish(): void {
    if (this.picked().length === 0) return;
    this.end(this.picked());
  }

  private end(picked: readonly PickedCall[]): void {
    const request = this.request();
    if (!request) return;
    const results = { ...this.state().results, [request.requester]: { picked, resume: request.resume ?? null } };
    this.update({ request: null, picked: [], results });
    this.router.navigateByUrl(request.returnUrl);
  }

  /**
   * Reactive, so a requester that is still alive when Return is pressed (the resend dialog lives
   * in the layout; Return to the page you are already on does not rebuild it) can react in an
   * effect, and one that was rebuilt can check once on creation - both then call takeResult.
   */
  hasResult(requester: string): boolean {
    return requester in this.state().results;
  }

  /** Handed over once: a second call, or a later visit, gets null. */
  takeResult(requester: string): PickResult | null {
    const result = this.state().results[requester] ?? null;
    if (result) {
      const { [requester]: _taken, ...rest } = this.state().results;
      this.update({ results: rest });
    }
    return result;
  }

  private update(patch: Partial<Stored>): void {
    const next = { ...this.state(), ...patch };
    this.state.set(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked - the pick still works, it just will not survive a reload.
    }
  }
}

/** Only what the bar and a requester need - a pick must not drag a hydrated body into sessionStorage. */
function summaryOf(call: CallRecord): CallRecord {
  const { request: _request, wsMessages: _ws, ...rest } = call;
  return rest.response ? { ...rest, response: { status: rest.response.status } } : rest;
}

function load(): Stored {
  const empty: Stored = { request: null, picked: [], results: {} };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Stored) } : empty;
  } catch {
    return empty;
  }
}
