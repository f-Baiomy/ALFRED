import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subject, merge, of, timer } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { CallRecord, SortMode } from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { PinService } from '../services/pin.service';
import { callKey, matchesSearch, sortCalls, supplierOf } from '../../shared/utils/call-utils';

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 20;

export interface SupplierOption {
  readonly name: string;
  readonly count: number;
}

export interface CallStats {
  readonly total: number;
  readonly ok: number;
  readonly client: number;
  readonly failed: number;
}

export interface SupplierGroup {
  readonly supplier: string;
  readonly calls: readonly CallRecord[];
}

/**
 * Single source of truth for the dashboard: polls the backend, and derives
 * every filtered/sorted/paginated/grouped view of the data as a computed
 * signal. Components inject this directly instead of drilling props through
 * a parent chain, which is what keeps them decoupled from each other.
 */
@Injectable({ providedIn: 'root' })
export class CallsStateService {
  private readonly api = inject(CallsApiService);
  private readonly pinService = inject(PinService);

  readonly limit = signal(50);
  readonly sortMode = signal<SortMode>('newest');
  readonly searchQuery = signal('');
  readonly supplierFilter = signal('');
  readonly groupBySupplier = signal(false);
  readonly expanded = signal(true);
  /** Bumped every time toggleExpanded() runs - individual panels watch this to know when a bulk "Collapse/Expand all" click should override their own local open state. */
  readonly collapseAllVersion = signal(0);
  readonly visibleCount = signal(PAGE_SIZE);
  readonly error = signal<string | null>(null);

  /** Calls picked for bulk export, keyed by callKey() - not tied to sort/filter/pagination, so a selection survives those changing underneath it. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  readonly loadMorePageSize = PAGE_SIZE;

  private readonly manualRefresh = new Subject<void>();

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() =>
      this.api.getCalls(this.limit()).pipe(
        tap(() => this.error.set(null)),
        catchError((err: unknown) => {
          this.error.set(err instanceof Error ? err.message : String(err));
          return of<CallRecord[]>([]);
        })
      )
    )
  );

  readonly calls = toSignal(this.polled$, { initialValue: [] as CallRecord[] });
  readonly pinned = this.pinService.pinned;

  readonly supplierOptions = computed<SupplierOption[]>(() => {
    const counts = new Map<string, number>();
    for (const c of this.calls()) {
      counts.set(supplierOf(c), (counts.get(supplierOf(c)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  });

  readonly matchingCalls = computed(() => {
    const query = this.searchQuery().trim();
    const supplier = this.supplierFilter();
    return this.calls().filter((c) => matchesSearch(c, query) && (!supplier || supplierOf(c) === supplier));
  });

  readonly stats = computed<CallStats>(() => {
    const calls = this.matchingCalls();
    return {
      total: calls.length,
      ok: calls.filter((c) => c.response && c.response.status < 400).length,
      client: calls.filter((c) => c.response && c.response.status >= 400 && c.response.status < 500).length,
      failed: calls.filter((c) => c.error || (c.response && c.response.status >= 500)).length,
    };
  });

  // Pinned calls render in their own always-visible section, so they're
  // excluded from the main list here to avoid rendering (and duplicate
  // identity for) the same call twice.
  readonly mainListCalls = computed(() => {
    const pinnedIds = new Set(this.pinned().keys());
    const withoutPinned = this.matchingCalls().filter((c) => !pinnedIds.has(callKey(c)));
    return sortCalls(withoutPinned, this.sortMode());
  });

  private readonly effectiveVisibleCount = computed(() =>
    Math.max(PAGE_SIZE, Math.min(this.visibleCount(), this.mainListCalls().length))
  );

  readonly visibleCalls = computed(() => this.mainListCalls().slice(0, this.effectiveVisibleCount()));
  readonly remainingCount = computed(() => this.mainListCalls().length - this.visibleCalls().length);

  readonly groupedCalls = computed<SupplierGroup[]>(() => {
    const groups = new Map<string, CallRecord[]>();
    for (const c of this.mainListCalls()) {
      const supplier = supplierOf(c);
      const list = groups.get(supplier) ?? [];
      list.push(c);
      groups.set(supplier, list);
    }
    return [...groups.entries()]
      .map(([supplier, calls]) => ({ supplier, calls }))
      .sort((a, b) => b.calls.length - a.calls.length);
  });

  /** In current-sort-order, not click order - deterministic regardless of which one you happened to check first. */
  readonly selectedCalls = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    return sortCalls(this.calls(), this.sortMode()).filter((c) => ids.has(callKey(c)));
  });

  isSelected(call: CallRecord): boolean {
    return this.selectedIds().has(callKey(call));
  }

  toggleSelected(call: CallRecord): void {
    const id = callKey(call);
    const next = new Set(this.selectedIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selectedIds.set(next);
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /** Selects every call currently matching the search/supplier filter - not just the paginated slice - so "select all" behaves the way a user expects even before scrolling to load more. */
  selectAll(): void {
    this.selectedIds.set(new Set(this.matchingCalls().map(callKey)));
  }

  setLimit(limit: number): void {
    this.limit.set(limit);
    this.visibleCount.set(PAGE_SIZE);
    this.manualRefresh.next();
  }

  setSearchQuery(query: string): void {
    this.searchQuery.set(query);
    this.visibleCount.set(PAGE_SIZE);
  }

  setSortMode(mode: SortMode): void {
    this.sortMode.set(mode);
    this.visibleCount.set(PAGE_SIZE);
  }

  setSupplierFilter(supplier: string): void {
    this.supplierFilter.set(supplier);
    this.visibleCount.set(PAGE_SIZE);
  }

  toggleGroupBySupplier(): void {
    this.groupBySupplier.set(!this.groupBySupplier());
    this.visibleCount.set(PAGE_SIZE);
  }

  loadMore(): void {
    this.visibleCount.set(this.visibleCount() + PAGE_SIZE);
  }

  toggleExpanded(): void {
    this.expanded.set(!this.expanded());
    this.collapseAllVersion.set(this.collapseAllVersion() + 1);
  }

  refreshNow(): void {
    this.manualRefresh.next();
  }
}
