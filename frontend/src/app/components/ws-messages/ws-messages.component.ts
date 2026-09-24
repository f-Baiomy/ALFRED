import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, filter, of } from 'rxjs';
import { CallEndpointSource } from '../../core/models/call.model';
import { WsMessage } from '../../core/models/ws-message.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { WsMessagesEventsService } from '../../core/services/ws-messages-events.service';

const PAGE_SIZE = 200;

/**
 * One call's WebSocket messages - a windowed list (offset/limit, "Load more" rather than
 * fetching everything at once), loaded only once the card that embeds this is actually expanded.
 * An edited message shows its new content with the original viewable alongside it; a dropped one
 * shows as struck through. `dropped > 0` (the per-connection cap evicting the oldest messages)
 * shows as "N earlier messages not recorded" rather than silently starting mid-sequence.
 */
@Component({
  selector: 'app-ws-messages',
  standalone: true,
  templateUrl: './ws-messages.component.html',
})
export class WsMessagesComponent implements OnInit {
  private readonly api = inject(CallsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly wsMessagesEvents = inject(WsMessagesEventsService);

  readonly callId = input.required<string>();
  readonly source = input<CallEndpointSource>('external');

  readonly messages = signal<readonly WsMessage[]>([]);
  readonly total = signal(0);
  readonly dropped = signal(0);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly expandedOriginal = signal<number | null>(null);

  ngOnInit(): void {
    this.load();
    // No timer: re-fetches only when this call's own id is pushed over /ws/calls or
    // /ws/internal-calls (see CallsStateService.handleWsMessage / WsMessagesEventsService).
    this.wsMessagesEvents.appended$
      .pipe(
        filter((callId) => callId === this.callId()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        this.messages.set([]);
        this.load();
      });
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .getWsMessages(this.source(), this.callId(), this.messages().length, PAGE_SIZE)
      .pipe(
        catchError(() => {
          this.error.set('Could not load WebSocket messages.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((page) => {
        this.loading.set(false);
        if (!page) return;
        this.messages.update((current) => [...current, ...page.messages]);
        this.total.set(page.total);
        this.dropped.set(page.dropped);
      });
  }

  loadMore(): void {
    if (!this.loading() && this.messages().length < this.total()) {
      this.load();
    }
  }

  toggleOriginal(seq: number): void {
    this.expandedOriginal.set(this.expandedOriginal() === seq ? null : seq);
  }

  time(tsMillis: number): string {
    return new Date(tsMillis).toLocaleTimeString();
  }
}
