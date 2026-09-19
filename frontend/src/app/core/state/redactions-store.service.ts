import { Injectable, computed, inject, signal } from '@angular/core';
import { NewRedaction, Redaction, RedactionKind } from '../models/redaction.model';
import { RedactionsApiService } from '../services/redactions-api.service';

const REDACTIONS_CHANNEL_NAME = 'alfred-redactions';

/**
 * One global list of redactions, unlike CommentsStore's per-call cache.
 *
 * A comment belongs to exactly one call, so caching per call is natural. A redaction may be
 * `all`-scoped, which applies to every call in every export - including calls this tab has never
 * fetched. Keyed per call, an `all` redaction would have to be duplicated into every entry and kept
 * in step, and a call loaded later would silently miss it. The list is small (one row per thing a
 * human chose to hide), so holding all of it and filtering locally is both simpler and safer: the
 * failure mode of the alternative is an unredacted secret.
 */
@Injectable({ providedIn: 'root' })
export class RedactionsStore {
  private readonly api = inject(RedactionsApiService);
  private readonly channel = new BroadcastChannel(REDACTIONS_CHANNEL_NAME);

  private readonly _all = signal<readonly Redaction[]>([]);
  readonly all = this._all.asReadonly();
  private loaded = false;

  readonly count = computed(() => this._all().length);

  constructor() {
    this.channel.addEventListener('message', (event: MessageEvent<readonly Redaction[]>) => {
      if (Array.isArray(event.data)) this.set(event.data, { broadcast: false });
    });
    // Loaded eagerly rather than on first use, unlike CommentsStore. An export can be triggered
    // from a card menu without any panel ever having been opened, and a list that had not loaded
    // yet would redact nothing while reporting success - the one failure mode this whole feature
    // exists to prevent. One small request at startup is the cheaper side of that trade.
    this.ensureLoaded();
  }

  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.refresh();
  }

  refresh(): void {
    this.api.listAll().subscribe({
      next: (redactions) => this.set(redactions, { broadcast: false }),
      error: () => {
        // Leave the list as-is rather than retrying in a loop; an export simply redacts nothing new.
      },
    });
  }

  /** Everything that applies to one call - its own pins plus every global one. */
  forCall(callId: string): readonly Redaction[] {
    return this._all().filter((r) => r.scope === 'all' || r.callId === callId);
  }

  /** Whether a specific named thing is already hidden for this call, so the UI can show the control as active. */
  isRedacted(callId: string, kind: RedactionKind, name: string): Redaction | undefined {
    const lower = name.toLowerCase();
    return this._all().find(
      (r) => r.kind === kind && r.name.toLowerCase() === lower && (r.scope === 'all' || r.callId === callId)
    );
  }

  add(newRedaction: NewRedaction): void {
    this.api.create(newRedaction).subscribe((created) => this.set([...this._all(), created]));
  }

  remove(id: string): void {
    this.api.delete(id).subscribe(() => this.set(this._all().filter((r) => r.id !== id)));
  }

  private set(redactions: readonly Redaction[], options: { broadcast?: boolean } = {}): void {
    this._all.set(redactions);
    if (options.broadcast !== false) this.channel.postMessage(redactions);
  }
}
