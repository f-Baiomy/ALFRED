import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { finalize, shareReplay, tap } from 'rxjs/operators';
import { CallDetail } from '../models/call.model';

/**
 * Shared in-memory cache of hydrated call detail (full request/response), keyed by call id -
 * root-provided and reused across the dashboard and every session-cycle detail page, since detail
 * content is identical regardless of which view fetched it (a call captured into a cycle is the
 * same call whether you're looking at it there or on the Live Calls feed). In-memory only, not
 * persisted to sessionStorage - a page reload just means re-fetching on next expand, which is one
 * cheap request, and avoids storage-quota risk from potentially large cached bodies.
 *
 * Concurrent expands of the same call (e.g. two components racing, or a double-click) share the
 * one in-flight request via shareReplay rather than firing a second one.
 */
@Injectable({ providedIn: 'root' })
export class CallDetailCacheService {
  private readonly cache = new Map<string, CallDetail>();
  private readonly inFlight = new Map<string, Observable<CallDetail>>();

  /** Already-resolved detail for this call, if any - synchronous, for merging into a rendered CallRecord without waiting on an Observable. */
  get(callId: string): CallDetail | undefined {
    return this.cache.get(callId);
  }

  /** Returns the cached detail immediately if present, otherwise calls `fetcher()` once (sharing the in-flight request with any concurrent caller) and caches the result. */
  fetch(callId: string, fetcher: () => Observable<CallDetail>): Observable<CallDetail> {
    const cached = this.cache.get(callId);
    if (cached) {
      return of(cached);
    }
    const existing = this.inFlight.get(callId);
    if (existing) {
      return existing;
    }

    const request$ = fetcher().pipe(
      tap((detail) => this.cache.set(callId, detail)),
      finalize(() => this.inFlight.delete(callId)),
      shareReplay(1)
    );
    this.inFlight.set(callId, request$);
    return request$;
  }
}
