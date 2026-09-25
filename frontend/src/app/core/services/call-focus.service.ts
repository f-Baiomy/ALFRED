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

/** What a list page needs from its state to show one call: its source selected, and filtered to it. */
export interface FocusableList {
  selectedSources(): ReadonlySet<SourceKey>;
  toggleSource(key: SourceKey): void;
  setRequestIdFilter(requestId: string): void;
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
    if (requestId) list.setRequestIdFilter(requestId);
    const focus = this.pending();
    if (!focus || (focus.cycleId ?? null) !== (cycleId ?? null)) return;
    this.pending.set(null);
    const key: SourceKey = focus.direction === 'inbound' && focus.serviceName ? focus.serviceName : EXTERNAL_SOURCE_KEY;
    if (!list.selectedSources().has(key)) list.toggleSource(key);
  }

  /** The card has scrolled to itself - flash only once. */
  highlighted(callId: string): void {
    if (this.highlight() === callId) this.highlight.set(null);
  }
}
