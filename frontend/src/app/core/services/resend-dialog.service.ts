import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';

export interface ResendDialogState {
  readonly call: CallRecord;
  /** Set only when the call is being resent from inside a session cycle - see ResendRequest.cycleId. */
  readonly cycleId: string | null;
}

/** Single source of truth for "is the resend dialog open, and for which call" - mirrors ExportDialogService. */
@Injectable({ providedIn: 'root' })
export class ResendDialogService {
  readonly state = signal<ResendDialogState | null>(null);

  open(call: CallRecord, cycleId: string | null = null): void {
    this.state.set({ call, cycleId });
  }

  close(): void {
    this.state.set(null);
  }
}
