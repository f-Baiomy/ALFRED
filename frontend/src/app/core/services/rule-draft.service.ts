import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';

/** A new rule started from a logged call - "Use as answer in a new rule…" on a call card. */
export interface CallRuleDraft {
  readonly direction: 'outbound' | 'inbound';
  readonly callId: string;
  readonly method: string;
  readonly host: string;
  /** Path only, no query: a rule's pathContains matches the path, and one query value would make it match that single call and nothing else. */
  readonly path: string;
  /** The project an inbound call belongs to, so the rule is scoped to it. Null for outbound. */
  readonly serviceName: string | null;
}

/**
 * Carries a draft from a call card to the Interception page, which lives on another route. Handed
 * over once - take() clears it - so going back to Interception later opens the rule list, not the
 * same half-made rule again. Mirrors ResendDialogService.
 */
@Injectable({ providedIn: 'root' })
export class RuleDraftService {
  private readonly draft = signal<CallRuleDraft | null>(null);

  start(call: CallRecord): void {
    const inbound = call.source === 'internal';
    let host = '';
    let path = '';
    try {
      const url = new URL(call.url);
      host = url.hostname;
      path = url.pathname;
    } catch {
      path = call.url;
    }
    this.draft.set({
      direction: inbound ? 'inbound' : 'outbound',
      callId: call.id,
      method: (call.method || '').toUpperCase(),
      // An inbound call's host is always the reverse proxy's own - the project says where it went.
      host: inbound ? '' : host,
      path,
      serviceName: inbound ? call.service_name ?? null : null,
    });
  }

  take(): CallRuleDraft | null {
    const draft = this.draft();
    this.draft.set(null);
    return draft;
  }
}
