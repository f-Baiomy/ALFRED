import { Injectable, inject, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { CallRef, directionOf } from '../models/call-ref.model';
import { InterceptionRule, SourceCallRef } from '../models/interception.model';
import { CallFocusService } from './call-focus.service';
import type { EditorSnapshot } from '../../components/rule-editor/rule-editor.component';

/** What the popup rule editor opens with. */
export interface RuleDialogRequest {
  /** A new rule made from this call - "⚡+ Rule" on its card. */
  readonly fromCall?: { readonly ref: CallRef; readonly call: CallRecord } | null;
  /** An unsaved form parked while its "Made from…" call was looked at. */
  readonly snapshot?: EditorSnapshot | null;
  /** The saved rule a parked form belongs to, when it is an edit. */
  readonly rule?: InterceptionRule | null;
}

/**
 * The rule editor as a popup on any page (mounted once in main-layout, like the resend dialog),
 * so a rule can be made from a call without leaving the call list. Holding the request here, in
 * a root service, is what lets "Go to the call" hide the popup, move to another page and bring the
 * same unsaved form back with "Return to the rule".
 */
@Injectable({ providedIn: 'root' })
export class RuleDialogService {
  private readonly focus = inject(CallFocusService);

  readonly request = signal<RuleDialogRequest | null>(null);
  /** Parked: the editor is closed and a "Return to the rule" bar stands in for it. */
  readonly parked = signal(false);
  /** "Rule for POST /cart" - what the Return bar calls the parked rule. */
  readonly parkedTitle = signal('');

  openFromCall(call: CallRecord, ref: CallRef): void {
    this.parked.set(false);
    this.request.set({ fromCall: { ref, call } });
  }

  /**
   * "Made from…" in any rule editor - this popup's or the Interception tab's: keep the form here,
   * go to the call, and wait for Return.
   */
  goToCall(source: SourceCallRef, snapshot: EditorSnapshot, rule: InterceptionRule | null): void {
    this.request.set({ snapshot, rule });
    this.parkedTitle.set(snapshot.draft.name || 'new rule');
    this.parked.set(true);
    this.focus.go({
      callId: source.callId,
      cycleId: source.cycleId ?? null,
      direction: source.direction,
      serviceName: source.serviceName ?? null,
    });
  }

  returnToRule(): void {
    this.parked.set(false);
  }

  close(): void {
    this.parked.set(false);
    this.request.set(null);
  }
}

/** A call as a rule's "Made from…" reference - how it reads now, kept even after the call is gone. */
export function sourceCallOf(call: CallRecord, ref: CallRef): SourceCallRef {
  let where = call.url;
  try {
    const u = new URL(call.original_url || call.url);
    where = u.host + u.pathname;
  } catch {
    // Not a URL - the raw one reads well enough.
  }
  const status = call.response?.status ?? null;
  return {
    direction: directionOf(ref),
    callId: ref.callId,
    cycleId: ref.cycleId ?? null,
    label: `${(call.method || '').toUpperCase()} ${where}${status != null ? ` · ${status}` : ''}`.slice(0, 300),
    serviceName: directionOf(ref) === 'inbound' ? call.service_name ?? null : null,
  };
}
