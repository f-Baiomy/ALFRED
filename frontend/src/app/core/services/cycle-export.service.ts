import { Injectable, Signal, inject, signal } from '@angular/core';
import { EMPTY, Observable, forkJoin, from, of } from 'rxjs';
import { catchError, expand, map, mergeMap, reduce, switchMap, toArray } from 'rxjs/operators';
import { CallEndpointSource, CallOverlapCandidate, CallRecord, SessionCycle } from '../models/call.model';
import { Comment } from '../models/comment.model';
import { ExportedCycle, ExportedSpacer, ExportMetadata } from '../models/export-metadata.model';
import { CallsQuery } from '../state/call-list-view';
import { CommentsApiService } from './comments-api.service';
import { ExportApiService } from './export-api.service';
import { ExportDialogService } from './export-dialog.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

const PAGE_SIZE = 200;

/**
 * How many per-call requests (detail, then comments) are in flight at once.
 *
 * The bulk actions bar can forkJoin its whole selection because a selection is user-sized; a cycle
 * is not. A 400-call cycle would otherwise open 800 simultaneous connections to a backend that
 * keeps an inbound slice's whole retained window in memory - so this is throttled rather than
 * fanned out. Six is enough to stay well ahead of the browser's own per-host connection limit
 * without turning an export into a load test.
 */
const REQUEST_CONCURRENCY = 6;

/**
 * Every filter field neutral, oldest first. A whole-cycle export deliberately ignores whatever
 * search/supplier/session filters the detail page happens to have applied: the file claims to be
 * the complete capture (see ExportedCycle), so it is fetched from the API directly rather than
 * from the list's loaded window, which is one page narrowed by the active filters (see
 * call-list-view.ts: matchingCalls is "everything loaded so far").
 */
function pageQuery(offset: number): CallsQuery {
  return { search: '', supplier: '', sort: 'oldest', offset, limit: PAGE_SIZE, sessionId: '', operationId: '', requestId: '' };
}

function exportedCycleOf(cycle: SessionCycle): ExportedCycle {
  return { id: cycle.id, name: cycle.name, assignedTo: cycle.assignedTo, status: cycle.status, createdAt: cycle.createdAt ?? null };
}

/**
 * Exports a whole session cycle - every captured call in it, both directions - as a report or as
 * JSON, by paging the cycle's calls out of the API and handing the result to the shared export
 * dialog. Distinct from the bulk actions bar's "select all then export", which can only ever cover
 * the rows currently loaded under the active filters.
 */
@Injectable({ providedIn: 'root' })
export class CycleExportService {
  private readonly api = inject(SessionCyclesApiService);
  private readonly commentsApi = inject(CommentsApiService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);

  private readonly exportingCycleIdState = signal<string | null>(null);
  private readonly progressState = signal<string | null>(null);
  private readonly messageState = signal<string | null>(null);

  /** The cycle currently being gathered, if any - a per-row button can spinner/disable off this. */
  readonly exportingCycleId: Signal<string | null> = this.exportingCycleIdState.asReadonly();
  /** Human-readable progress while gathering, since a large cycle takes many requests. */
  readonly progress: Signal<string | null> = this.progressState.asReadonly();
  /** Set when the export could not be opened at all (empty cycle, or a failed fetch). */
  readonly message: Signal<string | null> = this.messageState.asReadonly();

  exportCycle(cycle: SessionCycle, format: 'markdown' | 'json'): void {
    if (this.exportingCycleIdState() !== null) return;
    this.exportingCycleIdState.set(cycle.id);
    this.messageState.set(null);
    this.progressState.set('Loading calls…');

    this.collectCalls(cycle.id)
      .pipe(
        switchMap((calls) => {
          if (calls.length === 0) return of(null);
          this.progressState.set(`Loading ${calls.length} calls…`);
          return this.hydrateAll(cycle.id, calls).pipe(
            switchMap((hydrated) =>
              forkJoin({
                calls: of(hydrated),
                commentsByCallId: this.fetchAllComments(hydrated),
                overlapCandidates: this.fetchOverlaps(cycle.id, hydrated),
                metadata: this.fetchMetadata(hydrated),
                spacers: this.fetchSpacers(cycle.id),
              })
            )
          );
        })
      )
      .subscribe({
        next: (result) => {
          this.finish();
          if (!result) {
            this.messageState.set(`"${cycle.name}" has no captured calls to export.`);
            return;
          }
          // 'all' rather than the detail page's current status pill: this export is the cycle, not
          // a filtered view of it.
          this.exportDialog.open(
            result.calls,
            result.metadata,
            result.commentsByCallId,
            format,
            result.overlapCandidates,
            'all',
            exportedCycleOf(cycle),
            result.spacers
          );
        },
        error: () => {
          this.finish();
          this.messageState.set(`Could not export "${cycle.name}" - loading its calls failed.`);
        },
      });
  }

  private finish(): void {
    this.exportingCycleIdState.set(null);
    this.progressState.set(null);
  }

  /** Both directions - an inbound-only or mixed cycle must export as completely as an outbound one. */
  private collectCalls(cycleId: string): Observable<CallRecord[]> {
    return forkJoin([this.collectSource(cycleId, 'external'), this.collectSource(cycleId, 'internal')]).pipe(
      map(([external, internal]) => [...external, ...internal])
    );
  }

  /** Pages to completion: one request per PAGE_SIZE rows until `total` is covered. */
  private collectSource(cycleId: string, source: CallEndpointSource): Observable<CallRecord[]> {
    const fetchFrom = (offset: number) => this.api.listCalls(cycleId, pageQuery(offset), source).pipe(map((page) => ({ page, offset })));
    return fetchFrom(0).pipe(
      expand(({ page, offset }) => {
        const next = offset + PAGE_SIZE;
        // The empty-page guard matters as much as the total: a backend that reports a stale total
        // would otherwise page forever.
        return next < page.total && page.calls.length > 0 ? fetchFrom(next) : EMPTY;
      }),
      reduce((all, { page }) => [...all, ...page.calls.map((c) => c.call)], [] as CallRecord[])
    );
  }

  /**
   * List rows are summaries (no request/response bodies) and exports must never truncate, so every
   * call is refetched in full. Results are re-sorted back into input order - mergeMap completes
   * them out of order, and export ordering is meaningful.
   */
  private hydrateAll(cycleId: string, calls: readonly CallRecord[]): Observable<CallRecord[]> {
    let done = 0;
    return from(calls.map((call, index) => ({ call, index }))).pipe(
      mergeMap(
        ({ call, index }) =>
          this.api.getDetail(cycleId, call.id, call.source ?? 'external').pipe(
            map((detail) => {
              this.progressState.set(`Fetching details ${++done}/${calls.length}…`);
              return { index, call: { ...call, ...detail } as CallRecord };
            })
          ),
        REQUEST_CONCURRENCY
      ),
      toArray(),
      map((results) => results.sort((a, b) => a.index - b.index).map((r) => r.call))
    );
  }

  private fetchAllComments(calls: readonly CallRecord[]): Observable<ReadonlyMap<string, readonly Comment[]>> {
    let done = 0;
    return from(calls).pipe(
      mergeMap(
        (call) =>
          this.commentsApi.listForCall(call.id).pipe(
            catchError(() => of<Comment[]>([])),
            map((comments) => {
              this.progressState.set(`Fetching comments ${++done}/${calls.length}…`);
              return [call.id, comments] as const;
            })
          ),
        REQUEST_CONCURRENCY
      ),
      toArray(),
      map((entries) => new Map(entries))
    );
  }

  /** Same range-spanning query the bulk export path runs, minus the filters - see pageQuery. */
  private fetchOverlaps(cycleId: string, calls: readonly CallRecord[]): Observable<readonly CallOverlapCandidate[]> {
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const call of calls) {
      const start = new Date(call.timestamp).getTime();
      if (Number.isNaN(start)) continue;
      const end = start + (call.duration_ms ?? 0);
      if (start < minStart) minStart = start;
      if (end > maxEnd) maxEnd = end;
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return of([]);
    return this.api
      .getCallOverlaps(cycleId, {
        from: new Date(minStart).toISOString(),
        to: new Date(maxEnd).toISOString(),
        search: '',
        supplier: '',
        sessionId: '',
        operationId: '',
        requestId: '',
      })
      .pipe(catchError(() => of<CallOverlapCandidate[]>([])));
  }

  private fetchMetadata(calls: readonly CallRecord[]): Observable<ExportMetadata | null> {
    return this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of<ExportMetadata | null>(null)));
  }

  /** CycleSpacer.afterCallId is already the underlying CallRecord's own id (same id every exported call is keyed by - see CycleSpacer's doc), so no remapping is needed here, unlike removeCall/findByCallId which key on the captured-call wrapper id instead. */
  private fetchSpacers(cycleId: string): Observable<ExportedSpacer[]> {
    return this.api.listSpacers(cycleId).pipe(
      map((spacers) => spacers.map((spacer) => ({ label: spacer.label, afterCallId: spacer.afterCallId ?? null, anchorTimestamp: spacer.anchorTimestamp ?? null }))),
      catchError(() => of<ExportedSpacer[]>([]))
    );
  }
}
