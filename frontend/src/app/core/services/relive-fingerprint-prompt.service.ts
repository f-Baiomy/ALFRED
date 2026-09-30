import { Injectable, signal } from '@angular/core';

export interface FingerprintScreenView {
  readonly outbound: number;
  readonly warning: boolean;
  readonly allowClose: boolean;
}

/**
 * The fingerprint screen shared by the Relive list and Live Calls. Closing it does not cancel a
 * create that is already on the wire; the caller checks {@code isClosed} before it asks the
 * server to hash.
 */
@Injectable({ providedIn: 'root' })
export class ReliveFingerprintPrompt {
  readonly view = signal<FingerprintScreenView | null>(null);
  private closed = false;

  async run<T>(outbound: number, allowClose: boolean, work: (isClosed: () => boolean) => Promise<T>): Promise<T> {
    this.closed = false;
    this.view.set({ outbound, warning: false, allowClose });
    try {
      return await work(() => this.closed);
    } finally {
      this.view.set(null);
    }
  }

  requestClose(): void {
    const current = this.view();
    if (!current?.allowClose || current.warning) return;
    this.view.set({ ...current, warning: true });
  }

  keepWaiting(): void {
    const current = this.view();
    if (!current) return;
    this.view.set({ ...current, warning: false });
  }

  confirmClose(): void {
    this.closed = true;
    this.view.set(null);
  }
}
