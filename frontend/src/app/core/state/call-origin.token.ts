import { InjectionToken, Signal } from '@angular/core';

/**
 * Where the calls rendered below this point come from. Provided by a session-cycle detail page;
 * absent everywhere else, which means the live log. A call card cannot tell on its own - a
 * captured call carries the live call's id - so anything that has to name a call precisely (a
 * pick, a resend) reads this.
 */
export interface CallOrigin {
  readonly cycleId: Signal<string | null>;
  /** How a pick from here is described in the pick bar, e.g. `Cycle "checkout-bug"`. */
  readonly label: Signal<string>;
}

export const CALL_ORIGIN = new InjectionToken<CallOrigin>('CALL_ORIGIN');

export const LIVE_ORIGIN_LABEL = 'Live calls';
