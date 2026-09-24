import { Component, DestroyRef, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, of, switchMap } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CallDetail, CallRecord } from '../../core/models/call.model';
import { RuleSource } from '../../core/models/interception.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import {
  AnswerListField,
  AnswerQuery,
  hasClientFilters,
  matchesAnswerFilters,
  parseAnswerQuery,
  toServerSearch,
  toggleToken,
} from '../../shared/utils/answer-search';
import { detectAndFormatBody } from '../../shared/utils/body-format';
import { durationClass, methodClass, statusClass, supplierOf } from '../../shared/utils/call-utils';
import { statusLabel } from '../../shared/utils/http-status';
import { relativeTime } from '../../shared/utils/relative-time';

export type FinderDirection = 'outbound' | 'inbound';

/** A call the user chose, and which log it came from. */
export interface FoundCall {
  readonly call: CallRecord;
  readonly direction: FinderDirection;
}

interface Preview {
  readonly callId: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly status: number | null;
  readonly contentType: string;
  readonly headerCount: number;
  readonly sizeBytes: number;
  readonly body: string;
}

/** Plain text only: one page is all the server ever needs to look at. */
const SEARCH_LIMIT = 20;
/** Anything the server cannot filter on is filtered here, so a page has to be big enough to leave something after it. */
const SCAN_LIMIT = 200;
/** Scanning keeps going on its own until this many rows show, or MAX_AUTO_PAGES pages have been read - never unbounded. */
const FILL_TARGET = 10;
const MAX_AUTO_PAGES = 5;

export const METHOD_CHIPS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const STATUS_CHIPS = ['2xx', '3xx', '4xx', '5xx', 'failed'] as const;
export const WINDOW_CHIPS: readonly { readonly minutes: number | null; readonly label: string }[] = [
  { minutes: null, label: 'Any time' },
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 1440, label: '24 h' },
];

interface Fetch {
  readonly direction: FinderDirection;
  readonly search: string;
  readonly serviceNames: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly append: boolean;
  readonly autoPages: number;
}

/**
 * Finds one logged call: the search box takes `host:` / `path:` / `method:` / `status:` / `body:`
 * tokens (see answer-search.ts) and the chips edit the same text; only one substring reaches the
 * server, so the rest is applied here to bigger pages, with Load more reading further back. The
 * rule's own host, path and methods narrow the list by default and can be switched off.
 *
 * Clicking a row previews the half the caller cares about (`part`); only the preview's button
 * chooses it - the component itself never copies or stores anything, so the stored-answer picker
 * and "Copy from a call…" can each decide what choosing means. "Pick from anywhere…" hands off to
 * CallPickerService through the host.
 *
 * Fetch on demand only - a search runs when the text, a filter or the direction changes, never on
 * a timer.
 */
@Component({
  selector: 'app-call-finder',
  standalone: true,
  templateUrl: './call-finder.component.html',
})
export class CallFinderComponent implements OnInit {
  private readonly calls = inject(CallsApiService);
  private readonly destroyRef = inject(DestroyRef);

  /** The rule being edited - its match narrows the list until "Matches this rule" is switched off. */
  readonly ruleHost = input<string>('');
  readonly rulePath = input<string>('');
  readonly ruleMethods = input<readonly string[]>([]);
  readonly ruleSource = input<RuleSource>('both');
  readonly ruleServiceNames = input<readonly string[]>([]);
  /** Opens on this direction instead of the rule's - e.g. the one a call was just picked from. */
  readonly initialDirection = input<FinderDirection | null>(null);
  /** Which half the preview shows. */
  readonly part = input<'request' | 'response'>('response');
  /** The preview button's words. */
  readonly pickLabel = input('Use this call');
  /** Disables choosing (while the host is busy with the last choice). */
  readonly busy = input(false);
  /** A response is required to choose (the stored-answer case) - a call that never got one can be previewed but not chosen. */
  readonly needsResponse = input(false);

  /** Off where the host cannot park itself while the user is on another tab (e.g. a throwaway preview). */
  readonly allowPickAnywhere = input(true);

  readonly chosen = output<FoundCall>();
  readonly pickAnywhere = output<void>();

  readonly methodChips = METHOD_CHIPS;
  readonly statusChips = STATUS_CHIPS;
  readonly windowChips = WINDOW_CHIPS;

  readonly direction = signal<FinderDirection>('outbound');
  readonly search = signal('');
  readonly useRule = signal(true);
  readonly windowMinutes = signal<number | null>(null);
  readonly showHelp = signal(false);
  readonly results = signal<readonly CallRecord[]>([]);
  readonly total = signal(0);
  readonly scanned = signal(0);
  readonly loading = signal(false);
  readonly preview = signal<Preview | null>(null);
  readonly activeIndex = signal(-1);
  /** Read once per fetch, never ticking - "3 min ago" is as of the last search, which is what a list with no polling can honestly say. */
  readonly now = signal(Date.now());

  readonly parsed = computed(() => parseAnswerQuery(this.search()));

  /** Whether the rule has anything to narrow by, in the direction being searched. */
  readonly ruleFilterAvailable = computed(() => {
    if (this.ruleSource() !== 'both' && this.ruleSource() !== this.direction()) return false;
    return !!(this.ruleHost().trim() || this.rulePath().trim() || this.ruleMethods().length || this.ruleServiceNamesFor().length);
  });

  readonly ruleFilterLabel = computed(() =>
    [this.ruleMethods().join(','), this.ruleHost().trim(), this.rulePath().trim(), this.ruleServiceNamesFor().join(', ')]
      .filter(Boolean)
      .join(' ')
  );

  /** Typed tokens win over the rule's, field by field: typing `host:` searches that host even with the rule chip on. */
  readonly effective = computed<AnswerQuery>(() => {
    const typed = this.parsed();
    if (!this.useRule() || !this.ruleFilterAvailable()) return typed;
    return {
      ...typed,
      host: typed.host ?? (this.ruleHost().trim() || null),
      path: typed.path ?? (this.rulePath().trim() || null),
      methods: typed.methods.length ? typed.methods : this.ruleMethods().map((m) => m.toUpperCase()),
    };
  });

  readonly clientFiltered = computed(() => hasClientFilters(this.effective(), this.windowMinutes()));
  readonly hasMore = computed(() => this.scanned() < this.total());

  private readonly queries = new Subject<Fetch>();
  private nextOffset = 0;
  private started = false;

  constructor() {
    // Editing the rule's match while the finder is open re-narrows the list to the new match.
    // Debounced with every other search, so the first run and ngOnInit's own search are one request.
    effect(() => {
      this.ruleHost();
      this.rulePath();
      this.ruleMethods();
      this.ruleServiceNames();
      untracked(() => {
        if (this.started) this.runSearch();
      });
    });
  }

  ngOnInit(): void {
    const initial = this.initialDirection();
    if (initial) this.direction.set(initial);
    else if (this.ruleSource() === 'inbound') this.direction.set('inbound');
    this.queries
      .pipe(
        debounceTime(250),
        switchMap((fetch) => {
          this.loading.set(true);
          return this.calls
            .getCalls(
              { search: fetch.search, supplier: '', sort: 'newest', offset: fetch.offset, limit: fetch.limit, sessionId: '', operationId: '', requestId: '' },
              fetch.direction === 'inbound' ? 'internal' : 'external',
              fetch.serviceNames
            )
            .pipe(
              catchError(() => of({ calls: [], total: 0 })),
              map((page) => ({ fetch, page }))
            );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ fetch, page }) => this.onPage(fetch, page.calls, page.total));
    this.runSearch();
    this.started = true;
  }

  setDirection(direction: FinderDirection): void {
    if (this.direction() === direction) return;
    this.direction.set(direction);
    this.runSearch();
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.runSearch();
  }

  toggleChip(field: AnswerListField, value: string): void {
    this.search.set(toggleToken(this.search(), field, value));
    this.runSearch();
  }

  chipOn(field: AnswerListField, value: string): boolean {
    return this.effective()[field].includes(value);
  }

  setWindow(minutes: number | null): void {
    this.windowMinutes.set(minutes);
    this.runSearch();
  }

  toggleRule(): void {
    this.useRule.update((on) => !on);
    this.runSearch();
  }

  loadMore(): void {
    this.fetch(this.nextOffset, true, 0);
  }

  runSearch(): void {
    this.fetch(0, false, 0);
  }

  private fetch(offset: number, append: boolean, autoPages: number): void {
    const inbound = this.direction() === 'inbound';
    this.queries.next({
      direction: this.direction(),
      search: toServerSearch(this.effective()).trim(),
      serviceNames: inbound && this.useRule() && this.ruleFilterAvailable() ? this.ruleServiceNamesFor() : [],
      offset,
      limit: this.clientFiltered() ? SCAN_LIMIT : SEARCH_LIMIT,
      append,
      autoPages,
    });
  }

  private onPage(fetch: Fetch, calls: readonly CallRecord[], total: number): void {
    this.loading.set(false);
    this.now.set(Date.now());
    const kept = calls.filter((c) => matchesAnswerFilters(c, this.effective(), this.windowMinutes(), this.now()));
    this.results.set(fetch.append ? [...this.results(), ...kept] : kept);
    this.scanned.set((fetch.append ? this.scanned() : 0) + calls.length);
    this.total.set(total);
    this.nextOffset = fetch.offset + calls.length;
    if (!fetch.append) {
      this.preview.set(null);
      this.activeIndex.set(-1);
    }
    // A strict filter can leave a 200-call page empty while the match sits one page back - keep
    // reading a few pages rather than showing "No calls match" over a log that has one.
    if (this.clientFiltered() && calls.length > 0 && this.results().length < FILL_TARGET && this.hasMore() && fetch.autoPages + 1 < MAX_AUTO_PAGES) {
      this.fetch(this.nextOffset, true, fetch.autoPages + 1);
    }
  }

  countText(): string {
    const shown = this.results().length;
    if (!this.clientFiltered()) {
      const noun = this.total() === 1 ? 'match' : 'matches';
      return `${this.total()} ${noun} · newest first${this.total() > shown ? ' · showing ' + shown : ''}`;
    }
    return `${shown} ${shown === 1 ? 'match' : 'matches'} in the newest ${this.scanned()} of ${this.total()} calls`;
  }

  togglePreview(call: CallRecord, index: number): void {
    this.activeIndex.set(index);
    if (this.preview()?.callId === call.id) {
      this.preview.set(null);
      return;
    }
    this.preview.set({ callId: call.id, loading: true, failed: false, status: call.response?.status ?? null, contentType: '', headerCount: 0, sizeBytes: 0, body: '' });
    this.calls
      .getDetail(call.id, this.direction() === 'inbound' ? 'internal' : 'external')
      .pipe(
        map((detail) => ({ detail, failed: false })),
        catchError(() => of({ detail: null as CallDetail | null, failed: true })),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ detail, failed }) => {
        if (this.preview()?.callId !== call.id) return;
        const half = this.part() === 'request' ? detail?.request : detail?.response;
        const body = half?.body ?? '';
        const headers = half?.headers ?? {};
        this.preview.set({
          callId: call.id,
          loading: false,
          failed,
          status: detail?.response?.status ?? call.response?.status ?? null,
          contentType: headerValue(headers, 'content-type'),
          headerCount: Object.keys(headers).length,
          sizeBytes: new TextEncoder().encode(body).length,
          body: detectAndFormatBody(body).body,
        });
      });
  }

  onResultsKeydown(event: KeyboardEvent): void {
    const rows = this.results();
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, this.activeIndex() + step));
      this.activeIndex.set(next);
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.answer-result')[next]?.focus();
    }
  }

  choose(call: CallRecord): void {
    this.chosen.emit({ call, direction: this.direction() });
  }

  canChoose(call: CallRecord): boolean {
    return !this.busy() && (!this.needsResponse() || call.response?.status != null);
  }

  statusOf(call: CallRecord): string {
    return call.response?.status != null ? String(call.response.status) : call.error ? 'failed' : '…';
  }

  statusTitle(call: CallRecord): string {
    return call.response?.status != null ? statusLabel(call.response.status) : call.error ?? 'No response yet';
  }

  statusClassOf(call: CallRecord): string {
    return call.response?.status == null && !call.error ? '' : statusClass(call.response?.status);
  }

  methodClassOf(call: CallRecord): string {
    return methodClass(call.method);
  }

  durationClassOf(call: CallRecord): string {
    return durationClass(call.duration_ms);
  }

  durationText(call: CallRecord): string {
    const ms = call.duration_ms;
    if (ms == null) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  }

  hostOf(call: CallRecord): string {
    return supplierOf(call);
  }

  pathOf(call: CallRecord): string {
    try {
      const url = new URL(call.url);
      return url.pathname + url.search;
    } catch {
      return call.url;
    }
  }

  whenText(call: CallRecord): string {
    return relativeTime(call.timestamp, this.now());
  }

  whenTitle(call: CallRecord): string {
    const at = new Date(call.timestamp);
    return Number.isNaN(at.getTime()) ? call.timestamp : at.toLocaleString();
  }

  sizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private ruleServiceNamesFor(): readonly string[] {
    return this.direction() === 'inbound' ? this.ruleServiceNames() : [];
  }
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : '';
}
