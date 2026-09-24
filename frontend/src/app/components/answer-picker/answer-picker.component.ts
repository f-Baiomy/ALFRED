import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, of, switchMap } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CallDetail, CallRecord } from '../../core/models/call.model';
import { RuleSource, SecretsDecisionRequired, StoredAnswer } from '../../core/models/interception.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { InterceptionApiService } from '../../core/services/interception-api.service';
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
import { StatusPickerComponent } from '../status-picker/status-picker.component';

type Direction = 'outbound' | 'inbound';

/** A call picked whose response carries secrets - waiting for keep or strip. */
interface PendingSecrets {
  readonly callId: string;
  readonly direction: Direction;
  readonly secretNames: readonly string[];
}

/** A call to copy the moment the picker opens - "Use as answer in a new rule…" from a Live Calls card. */
export interface AnswerPreselect {
  readonly direction: Direction;
  readonly callId: string;
}

interface Preview {
  readonly callId: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly status: number | null;
  readonly contentType: string;
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
  readonly direction: Direction;
  readonly search: string;
  readonly serviceNames: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly append: boolean;
  readonly autoPages: number;
}

/**
 * Picks the logged call a stored-answer action answers with, and shows the stored copy once one
 * exists.
 *
 * The search box takes `host:` / `path:` / `method:` / `status:` / `body:` tokens (see
 * answer-search.ts); the chips edit the same text. Only one substring reaches the server, so the
 * rest is applied here to bigger pages, with Load more reading further back. The rule's own host,
 * path and methods narrow the list by default - the call you want almost always matches the rule
 * you are writing - and can be switched off.
 *
 * Clicking a row previews the response; only the preview's button copies it. The copy is then made
 * at once - not on save - so the rule keeps working after the original call has been evicted from
 * the log. A response that carries secret headers is never stored on the user's behalf either way:
 * the backend answers 409 with their names and this asks, with no default, before retrying with
 * the choice (FR-026).
 *
 * Fetch on demand only - a search runs when the text, a filter or the direction changes, never on
 * a timer.
 */
@Component({
  selector: 'app-answer-picker',
  standalone: true,
  imports: [StatusPickerComponent],
  templateUrl: './answer-picker.component.html',
})
export class AnswerPickerComponent implements OnInit {
  private readonly calls = inject(CallsApiService);
  private readonly api = inject(InterceptionApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly answerId = input<string | null | undefined>(null);
  /** ANSWER_WITH_FILE: the answer comes from an upload, so the picker shows a file input instead of a call search. */
  readonly uploadMode = input<boolean>(false);
  /** The rule being edited - its match narrows the list until "Matches this rule" is switched off. */
  readonly ruleHost = input<string>('');
  readonly rulePath = input<string>('');
  readonly ruleMethods = input<readonly string[]>([]);
  readonly ruleSource = input<RuleSource>('both');
  readonly ruleServiceNames = input<readonly string[]>([]);
  readonly preselect = input<AnswerPreselect | null>(null);
  /** Emits the new stored answer's id - the rule editor writes it onto the action. */
  readonly answerChange = output<string>();

  readonly methodChips = METHOD_CHIPS;
  readonly statusChips = STATUS_CHIPS;
  readonly windowChips = WINDOW_CHIPS;

  readonly uploadFile = signal<File | null>(null);
  readonly uploadContentType = signal('');
  readonly uploadStatus = signal<number | null>(null);

  readonly direction = signal<Direction>('outbound');
  readonly search = signal('');
  readonly useRule = signal(true);
  readonly windowMinutes = signal<number | null>(null);
  readonly showHelp = signal(false);
  readonly results = signal<readonly CallRecord[]>([]);
  readonly total = signal(0);
  readonly scanned = signal(0);
  readonly loading = signal(false);
  readonly copying = signal(false);
  readonly error = signal<string | null>(null);
  readonly pending = signal<PendingSecrets | null>(null);
  readonly answer = signal<StoredAnswer | null>(null);
  readonly preview = signal<Preview | null>(null);
  readonly activeIndex = signal(-1);
  /** Read once per fetch, never ticking - "3 min ago" is as of the last search, which is what a list with no polling can honestly say. */
  readonly now = signal(Date.now());
  /** True while an attached answer is being replaced - the picker shows instead of the card. */
  readonly changing = signal(false);

  readonly showPicker = computed(() => this.changing() || !this.answerId());

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

  constructor() {
    // Loads the card for whatever answer the action holds - once when opened, again after a pick.
    effect(() => {
      const id = this.answerId();
      untracked(() => {
        if (!id) {
          this.answer.set(null);
        } else if (this.answer()?.id !== id) {
          this.api
            .getAnswer(id)
            .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
            .subscribe((answer) => this.answer.set(answer));
        }
      });
    });

    // Editing the rule's match while the picker is open re-narrows the list to the new match.
    // Debounced with every other search, so the first run and ngOnInit's own search are one request.
    effect(() => {
      this.ruleHost();
      this.rulePath();
      this.ruleMethods();
      this.ruleServiceNames();
      untracked(() => {
        if (this.started && this.showPicker() && !this.uploadMode()) this.runSearch();
      });
    });
  }

  private started = false;

  ngOnInit(): void {
    if (this.ruleSource() === 'inbound') this.direction.set('inbound');
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

    const preselect = this.preselect();
    if (preselect && !this.answerId()) {
      this.direction.set(preselect.direction);
      this.copy(preselect.callId, preselect.direction, null);
    }
    // An action that already has its answer shows the card, and needs no search until "Change…".
    if (this.showPicker() && !this.uploadMode()) this.runSearch();
    this.started = true;
  }

  setDirection(direction: Direction): void {
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

  private runSearch(): void {
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
    this.preview.set({ callId: call.id, loading: true, failed: false, status: call.response?.status ?? null, contentType: '', sizeBytes: 0, body: '' });
    this.calls
      .getDetail(call.id, this.direction() === 'inbound' ? 'internal' : 'external')
      .pipe(
        map((detail) => ({ detail, failed: false })),
        catchError(() => of({ detail: null as CallDetail | null, failed: true })),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ detail, failed }) => {
        if (this.preview()?.callId !== call.id) return;
        const body = detail?.response?.body ?? '';
        this.preview.set({
          callId: call.id,
          loading: false,
          failed,
          status: detail?.response?.status ?? call.response?.status ?? null,
          contentType: headerValue(detail?.response?.headers, 'content-type'),
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

  pick(call: CallRecord): void {
    this.copy(call.id, this.direction(), null);
  }

  keepSecrets(keep: boolean): void {
    const pending = this.pending();
    if (!pending) return;
    this.copy(pending.callId, pending.direction, keep);
  }

  cancelSecrets(): void {
    this.pending.set(null);
  }

  startChange(): void {
    this.changing.set(true);
    if (!this.uploadMode()) this.runSearch();
  }

  cancelChange(): void {
    this.changing.set(false);
  }

  private copy(callId: string, direction: Direction, keepSecrets: boolean | null): void {
    this.copying.set(true);
    this.error.set(null);
    this.api
      .copyAnswerFromCall({ direction, callId, keepSecrets })
      .pipe(
        map((answer) => ({ answer, failure: null as HttpErrorResponse | null })),
        catchError((failure: HttpErrorResponse) => of({ answer: null, failure })),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ answer, failure }) => {
        this.copying.set(false);
        if (answer) {
          this.pending.set(null);
          this.changing.set(false);
          this.preview.set(null);
          this.answer.set(answer);
          this.answerChange.emit(answer.id);
          return;
        }
        if (failure?.status === 409) {
          const body = failure.error as SecretsDecisionRequired;
          this.pending.set({ callId, direction, secretNames: body?.secretNames ?? [] });
        } else if (failure?.status === 413) {
          const body = failure.error as { limitBytes?: number; sizeBytes?: number };
          this.error.set(
            `That response is ${formatBytes(body?.sizeBytes ?? 0)}; a stored answer can be at most ${formatBytes(body?.limitBytes ?? 0)}.`
          );
        } else if (failure?.status === 404) {
          this.error.set('That call has no response to answer with - it is still in flight, failed, or has left the log.');
        } else {
          this.error.set('Could not copy that response. Try again.');
        }
      });
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.uploadFile.set(file);
    if (file && !this.uploadContentType()) {
      this.uploadContentType.set(file.type);
    }
  }

  onUploadContentType(event: Event): void {
    this.uploadContentType.set((event.target as HTMLInputElement).value);
  }

  onUploadStatus(status: number): void {
    this.uploadStatus.set(status);
  }

  upload(): void {
    const file = this.uploadFile();
    if (!file) return;
    this.copying.set(true);
    this.error.set(null);
    this.api
      .uploadAnswer(file, this.uploadContentType() || null, this.uploadStatus())
      .pipe(
        map((answer) => ({ answer, failure: null as HttpErrorResponse | null })),
        catchError((failure: HttpErrorResponse) => of({ answer: null, failure })),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ answer, failure }) => {
        this.copying.set(false);
        if (answer) {
          this.changing.set(false);
          this.answer.set(answer);
          this.uploadFile.set(null);
          this.uploadContentType.set('');
          this.uploadStatus.set(null);
          this.answerChange.emit(answer.id);
          return;
        }
        if (failure?.status === 413) {
          const body = failure.error as { limitBytes?: number; sizeBytes?: number };
          this.error.set(
            `That file is ${formatBytes(body?.sizeBytes ?? 0)}; a stored answer can be at most ${formatBytes(body?.limitBytes ?? 0)}.`
          );
        } else if (failure?.status === 415) {
          this.error.set('That file needs a content type before it can be stored.');
        } else {
          this.error.set('Could not upload that file. Try again.');
        }
      });
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
    return formatBytes(bytes);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
