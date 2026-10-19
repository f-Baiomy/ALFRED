import { Injectable, inject, signal } from '@angular/core';
import { EMPTY, Observable, concat, forkJoin, from, of } from 'rxjs';
import { catchError, expand, map, mergeMap, reduce, switchMap, toArray } from 'rxjs/operators';
import { CallEndpointSource, CallRecord, SessionCycle } from '../models/call.model';
import { CallDbCapture } from '../models/db-capture.model';
import { LinkedLogLine } from '../models/call-logs.model';
import { CallLogsApiService } from '../services/call-logs-api.service';
import { DbCaptureApiService } from '../services/db-capture-api.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { SessionCyclesStateService } from '../state/session-cycles-state.service';
import { CallsQuery } from '../state/call-list-view';
import { LinksStateService } from './links-state.service';
import { localPart, splitRef } from './remote-ref';

const PAGE_SIZE = 200;
const CONCURRENCY = 4;

/**
 * The id fields the owner's answers carry with the link's suffix (the backend's RefTagger.ID_FIELDS): a copy is this
 * Alfred's own, so every one of them goes back to the owner's plain id. Bodies, headers and rows are strings or maps
 * whose keys are never these, so nothing a call carried is touched.
 */
const ID_FIELDS = new Set(['id', 'callId', 'callIds', 'cycleId', 'cycleIds', 'parentId', 'parentCallId', 'capturedCallId', 'internalCallId',
  'originalCallId', 'sourceCallId', 'statementId', 'statementIds', 'sessionCycleId', 'boardId', 'boardIds', 'homeCycleId', 'homeBoardId',
  'commandId', 'storeCommandId', 'spacerId', 'afterCallId', 'evidenceCallId', 'relatedCycleId', 'capturedByCycleIds']);

/** Every id field of `value` without the `@<slug>` the link added (recursively; a copy - the input is never changed). */
export function untagged<T>(value: T, slug: string): T {
  const suffix = `@${slug}`;
  const strip = (v: unknown): unknown => (typeof v === 'string' && v.endsWith(suffix) ? v.slice(0, -suffix.length) : v);
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => (key && ID_FIELDS.has(key) ? strip(x) : walk(x, null)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = ID_FIELDS.has(k) && !Array.isArray(x) ? strip(x) : walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}

/** "copy of error flow · from STG 83 · 2026-10-19" - and back: the link's name, or null for any other cycle. */
export function copyName(name: string, from: string, at = new Date()): string {
  return `copy of ${name} · from ${from} · ${at.toISOString().slice(0, 10)}`;
}

export function copiedFrom(cycleName: string | null | undefined): string | null {
  const m = /^copy of .+ · from (.+) · \d{4}-\d{2}-\d{2}$/.exec(cycleName ?? '');
  return m ? m[1] : null;
}

function pageQuery(offset: number): CallsQuery {
  return { search: '', supplier: '', sort: 'oldest', offset, limit: PAGE_SIZE, sessionId: '', operationId: '', requestId: '' };
}

/**
 * Keep a copy (specs/035 D34): a cycle streamed in, fetched in full - every call with its bodies, statements, log
 * lines and spacers - and stored as a new local cycle through the same steps an import of its .json export takes. The
 * copy is this Alfred's for good (never live again); the streamed one stays as it was; the owner's read log says so.
 */
@Injectable({ providedIn: 'root' })
export class KeepCopyService {
  private readonly api = inject(SessionCyclesApiService);
  private readonly cycles = inject(SessionCyclesStateService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly links = inject(LinksStateService);

  /** The ref being copied and how far it is ("Fetching 12/40…"). */
  readonly busy = signal<string | null>(null);
  readonly progress = signal<string | null>(null);

  keepCopy(cycle: Pick<SessionCycle, 'id' | 'name' | 'assignedTo'>): Observable<SessionCycle> {
    const split = splitRef(cycle.id);
    if (!split) return new Observable((s) => s.error(new Error('That cycle is this Alfred\'s own')));
    if (this.busy()) return new Observable((s) => s.error(new Error('A copy is already being made')));
    const slug = split.slug;
    const from = this.links.nameOf(slug);
    this.busy.set(cycle.id);
    this.progress.set('Loading calls…');
    const done = <T>(o: Observable<T>) => new Observable<T>((sub) => {
      const s = o.subscribe({
        next: (v) => sub.next(v),
        error: (e) => {
          this.busy.set(null);
          this.progress.set(null);
          sub.error(e);
        },
        complete: () => {
          this.busy.set(null);
          this.progress.set(null);
          sub.complete();
        },
      });
      return () => s.unsubscribe();
    });
    return done(forkJoin([this.collect(cycle.id, 'external'), this.collect(cycle.id, 'internal')]).pipe(
      map(([a, b]) => [...a, ...b]),
      switchMap((calls) => this.hydrate(cycle.id, calls)),
      switchMap((calls) => forkJoin({
        calls: of(calls),
        captures: this.captures(calls),
        lines: this.lines(cycle.id, calls),
        spacers: this.api.listSpacers(cycle.id).pipe(catchError(() => of([]))),
      })),
      switchMap(({ calls, captures, lines, spacers }) => {
        this.progress.set('Storing the copy…');
        const plain = calls.map((c) => untagged(c, slug));
        return this.cycles.create({ name: copyName(cycle.name, from), assignedTo: cycle.assignedTo ?? null }).pipe(
          switchMap((copy) => {
            const dbImport$ = captures.length
              ? this.db.import(captures.map((c) => ({ callId: localPart(c.callId), dbCapture: untagged(c.dbCapture, slug) })))
              : of({ imported: 0 });
            const logImport$ = lines.length
              ? concat(...lines.flatMap(([id, l]) => {
                const parts: Observable<void>[] = [];
                for (let i = 0; i < l.length; i += 20_000) parts.push(this.logs.importLines(localPart(id), l.slice(i, i + 20_000)));
                return parts;
              })).pipe(toArray())
              : of([]);
            return this.api.copyCallsInto(copy.id, plain).pipe(
              switchMap(() => forkJoin({ db: dbImport$, logs: logImport$ })),
              switchMap(() => spacers.length
                ? concat(...spacers.map((s) => this.api.createSpacer(copy.id, s.label, s.afterCallId ? localPart(s.afterCallId) : null,
                  s.anchorTimestamp ?? null))).pipe(toArray())
                : of([])),
              switchMap(() => this.api.putNotes(copy.id, { description: `A copy of "${cycle.name}" kept from ${from} - not live.` })
                .pipe(catchError(() => of(copy)))),
              // the owner's read log: "PC-1 kept a copy of error flow"
              switchMap((c) => this.api.get(cycle.id, 'copy').pipe(catchError(() => of(null)), map(() => c))),
            );
          }),
        );
      }),
    ));
  }

  private collect(cycleId: string, source: CallEndpointSource): Observable<CallRecord[]> {
    const page = (offset: number) => this.api.listCalls(cycleId, pageQuery(offset), source, undefined, true).pipe(map((p) => ({ p, offset })));
    return page(0).pipe(
      expand(({ p, offset }) => (offset + PAGE_SIZE < p.total && p.calls.length > 0 ? page(offset + PAGE_SIZE) : EMPTY)),
      reduce((all, { p }) => [...all, ...p.calls.map((c) => c.call)], [] as CallRecord[]),
    );
  }

  /** Lists carry no bodies, and a copy never cuts call data: every call again in full. */
  private hydrate(cycleId: string, calls: readonly CallRecord[]): Observable<CallRecord[]> {
    let n = 0;
    return from(calls.map((call, index) => ({ call, index }))).pipe(
      mergeMap(({ call, index }) => this.api.getDetail(cycleId, call.id, call.source ?? 'external').pipe(
        map((detail) => {
          this.progress.set(`Fetching calls ${++n}/${calls.length}…`);
          return { index, call: { ...call, ...detail } as CallRecord };
        })), CONCURRENCY),
      toArray(),
      map((r) => r.sort((a, b) => a.index - b.index).map((x) => x.call)),
    );
  }

  private captures(calls: readonly CallRecord[]): Observable<{ callId: string; dbCapture: CallDbCapture }[]> {
    const inbound = calls.filter((c) => c.source === 'internal');
    if (!inbound.length) return of([]);
    return from(inbound).pipe(
      mergeMap((c) => this.db.exportCall(c.id).pipe(map((d) => ({ callId: c.id, dbCapture: d })), catchError(() => of(null))), CONCURRENCY),
      toArray(),
      map((all) => all.filter((x): x is { callId: string; dbCapture: CallDbCapture } => x !== null && hasStatements(x.dbCapture))),
    );
  }

  private lines(cycleId: string, calls: readonly CallRecord[]): Observable<[string, readonly LinkedLogLine[]][]> {
    const inbound = calls.filter((c) => c.source === 'internal');
    if (!inbound.length) return of([]);
    return from(inbound).pipe(
      mergeMap((c) => this.logs.allLines(c.id, cycleId).pipe(map((l) => [c.id, l] as [string, typeof l]), catchError(() => of(null))), CONCURRENCY),
      toArray(),
      map((all) => all.filter((x): x is [string, readonly LinkedLogLine[]] => !!x && x[1].length > 0)),
    );
  }
}

function hasStatements(c: CallDbCapture): boolean {
  return (c.statements?.length ?? 0) > 0 || (c.redis?.length ?? 0) > 0;
}
