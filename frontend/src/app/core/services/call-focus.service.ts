import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SourceKey } from '../models/call.model';
import { EXTERNAL_SOURCE_KEY } from '../../shared/utils/call-utils';

/** One call to go to - where it lives, and enough to make sure its source is showing. */
export interface CallFocus {
  readonly callId: string;
  /** The session cycle holding it; null for Live Calls. */
  readonly cycleId: string | null;
  readonly direction: 'outbound' | 'inbound';
  /** An inbound call's project - its source key in the Sources bar. */
  readonly serviceName: string | null;
}

/** What a list page needs from its state to POINT AT a call among all the others (see revealIn). */
export interface RevealableList {
  selectedSources(): ReadonlySet<SourceKey>;
  toggleSource(key: SourceKey): void;
  showOptionsCalls(): boolean;
  toggleShowOptionsCalls(): void;
}

/** What a list page needs from its state to show one call: its source selected, and filtered to it. */
export interface FocusableList {
  selectedSources(): ReadonlySet<SourceKey>;
  toggleSource(key: SourceKey): void;
  setRequestIdFilter(requestId: string): void;
  /** Cleared when a focus arrives - a text search left from before would hide the very call asked for. */
  setSearchQuery?(query: string): void;
}

/**
 * "Go to this call" from anywhere - the rule editor's "Made from…" reference. Navigates to Live
 * Calls or the call's cycle with `?requestId=` (the list's own call-id filter, so the call is shown
 * even when it is pages away or would be hidden by other filters), makes sure its source is
 * selected, and has its card scroll into view and flash once. Paged lists are why this filters
 * rather than searches the loaded cards: a call from yesterday is never in the first page.
 */
@Injectable({ providedIn: 'root' })
export class CallFocusService {
  private readonly router = inject(Router);

  /** Consumed by the list page it is for (see applyTo). */
  private readonly pending = signal<CallFocus | null>(null);
  /** The card to scroll to and flash - cleared by that card once it has. */
  readonly highlight = signal<string | null>(null);

  /** The call a cycle page should point at, with every other call still listed - cleared once it has (see revealed). */
  readonly reveal = signal<string | null>(null);
  private pendingReveal: (CallFocus & { readonly preflight: boolean }) | null = null;

  go(focus: CallFocus): void {
    this.pending.set(focus);
    this.highlight.set(focus.callId);
    void this.router.navigate(focus.cycleId ? ['/cycles', focus.cycleId] : ['/'], { queryParams: { requestId: focus.callId } });
  }

  /**
   * On a list page: the page's `?requestId=` becomes its call-id filter (so any link of that shape
   * works, not only this service's), and a pending focus for this page selects the call's source.
   */
  applyTo(list: FocusableList, cycleId: string | null, requestId: string | null): void {
    const focus = this.pending();
    const forThisPage = !!focus && (focus.cycleId ?? null) === (cycleId ?? null);
    if (forThisPage) list.setSearchQuery?.('');
    if (requestId) list.setRequestIdFilter(requestId);
    if (!focus || !forThisPage) return;
    this.pending.set(null);
    const key: SourceKey = focus.direction === 'inbound' && focus.serviceName ? focus.serviceName : EXTERNAL_SOURCE_KEY;
    if (!list.selectedSources().has(key)) list.toggleSource(key);
  }

  /**
   * "Show in cycle" from the floating cycle widget: the call's cycle page with EVERY call listed (not
   * filtered to this one, unlike go), scrolled to this call and pointing at it. `?reveal=` in the URL
   * makes the page the one to handle it; the page removes it again once it has, so a reload doesn't
   * point a second time.
   */
  revealIn(focus: CallFocus & { readonly preflight: boolean }): void {
    if (!focus.cycleId) return;
    this.pendingReveal = focus;
    this.reveal.set(focus.callId);
    void this.router.navigate(['/cycles', focus.cycleId], { queryParams: { reveal: focus.callId } });
  }

  /**
   * On a cycle page with `?reveal=`: makes sure the call CAN be shown - its source selected, OPTIONS
   * shown if it is a preflight - without filtering anything else away. A bare link (no pending
   * reveal, e.g. pasted) still points; it just can't know the source to switch on.
   */
  applyReveal(list: RevealableList, cycleId: string, callId: string): void {
    const focus = this.pendingReveal;
    if (focus && focus.cycleId === cycleId && focus.callId === callId) {
      this.pendingReveal = null;
      const key: SourceKey = focus.direction === 'inbound' && focus.serviceName ? focus.serviceName : EXTERNAL_SOURCE_KEY;
      if (!list.selectedSources().has(key)) list.toggleSource(key);
      if (focus.preflight && !list.showOptionsCalls()) list.toggleShowOptionsCalls();
    }
    this.reveal.set(callId);
  }

  /** The page has pointed at the call. */
  revealed(callId: string): void {
    if (this.reveal() === callId) this.reveal.set(null);
  }

  /** The card has scrolled to itself - flash only once. */
  highlighted(callId: string): void {
    if (this.highlight() === callId) this.highlight.set(null);
  }
}
