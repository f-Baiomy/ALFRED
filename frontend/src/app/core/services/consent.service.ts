import { Injectable, signal } from '@angular/core';

/** What a consent dialog shows: who asks, what will happen, exactly. */
export interface ConsentRequest {
  readonly title: string;
  /** Who asks: "The snippet “Fare dashboard”", "Claude's action chip". */
  readonly from: string;
  /** What will happen, one line each - plain words, the real target ("Move #35 to Fixed"). */
  readonly lines: readonly string[];
  /** The exact text that will be posted or run, shown as it is. */
  readonly exact?: string | null;
  readonly confirmLabel: string;
  /** Offer "don't ask again for this snippet" (R24's first-time consent for asks). */
  readonly remember?: string | null;
}

/**
 * Consent for anything a snippet, an action chip, a choice or a form would change (specs/017 R21): nothing on the
 * board is ever done for the user without this dialog and the user's own click. The one exception is what the user
 * said may happen without asking again - only for asking Claude from one snippet, only for this page load.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  readonly state = signal<ConsentRequest | null>(null);
  private resolve: ((ok: boolean) => void) | null = null;
  private readonly remembered = new Set<string>();

  ask(request: ConsentRequest): Promise<boolean> {
    if (request.remember && this.remembered.has(request.remember)) return Promise.resolve(true);
    this.resolve?.(false);
    this.state.set(request);
    return new Promise<boolean>((r) => { this.resolve = r; });
  }

  respond(ok: boolean, remember = false): void {
    const req = this.state();
    if (ok && remember && req?.remember) this.remembered.add(req.remember);
    this.state.set(null);
    const r = this.resolve;
    this.resolve = null;
    r?.(ok);
  }
}
