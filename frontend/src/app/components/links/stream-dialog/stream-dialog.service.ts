import { Injectable, signal } from '@angular/core';
import { StreamKind } from '../../../core/links/links.models';

/** What a Stream… button opens the dialog for: this Alfred's own cycle or board. */
export interface StreamTarget {
  readonly kind: StreamKind;
  readonly target: string;
  readonly name: string;
  readonly project: string | null;
}

/** The one Stream dialog (D5-D8, D12, D17), opened from the Session Cycles page, a cycle page and the board. */
@Injectable({ providedIn: 'root' })
export class StreamDialogService {
  readonly target = signal<StreamTarget | null>(null);

  open(t: StreamTarget): void {
    this.target.set(t);
  }

  close(): void {
    this.target.set(null);
  }
}
