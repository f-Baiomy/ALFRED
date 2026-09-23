import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, of, switchMap } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { SecretsDecisionRequired, StoredAnswer } from '../../core/models/interception.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { InterceptionApiService } from '../../core/services/interception-api.service';

type Direction = 'outbound' | 'inbound';

/** A call picked whose response carries secrets - waiting for keep or strip. */
interface PendingSecrets {
  readonly call: CallRecord;
  readonly direction: Direction;
  readonly secretNames: readonly string[];
}

const SEARCH_LIMIT = 20;

/**
 * Picks the logged call a stored-answer action answers with, and shows the stored copy once one
 * exists.
 *
 * Nothing is copied until a call is picked. The copy is then made at once - not on save - so the
 * rule keeps working after the original call has been evicted from the log. A response that
 * carries secret headers is never stored on the user's behalf either way: the backend answers 409
 * with their names and this asks, with no default, before retrying with the choice (FR-026).
 *
 * Fetch on demand only - a search runs when the text or the direction changes, never on a timer.
 */
@Component({
  selector: 'app-answer-picker',
  standalone: true,
  templateUrl: './answer-picker.component.html',
})
export class AnswerPickerComponent implements OnInit {
  private readonly calls = inject(CallsApiService);
  private readonly api = inject(InterceptionApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly answerId = input<string | null | undefined>(null);
  readonly kind = input<'RECORDED' | 'FILE'>('RECORDED');
  readonly status = input<number | null | undefined>(null);
  /** Emits the new stored answer's id - the rule editor writes it onto the action. */
  readonly answerChange = output<string>();

  readonly direction = signal<Direction>('outbound');
  readonly search = signal('');
  readonly results = signal<readonly CallRecord[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly copying = signal(false);
  readonly error = signal<string | null>(null);
  readonly pending = signal<PendingSecrets | null>(null);
  readonly answer = signal<StoredAnswer | null>(null);
  /** True while an attached answer is being replaced - the picker shows instead of the card. */
  readonly changing = signal(false);
  readonly uploadType = signal('');
  readonly uploading = signal(false);

  readonly showPicker = computed(() => this.changing() || !this.answerId());

  private selectedFile: File | null = null;
  private readonly queries = new Subject<{ direction: Direction; search: string }>();

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
  }

  ngOnInit(): void {
    this.queries
      .pipe(
        debounceTime(250),
        switchMap(({ direction, search }) => {
          this.loading.set(true);
          return this.calls
            .getCalls(
              { search, supplier: '', sort: 'newest', offset: 0, limit: SEARCH_LIMIT, sessionId: '', operationId: '', requestId: '' },
              direction === 'inbound' ? 'internal' : 'external'
            )
            .pipe(catchError(() => of({ calls: [], total: 0 })));
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((page) => {
        this.loading.set(false);
        this.results.set(page.calls);
        this.total.set(page.total);
      });
    // An action that already has its answer shows the card, and needs no search until "Change…".
    if (this.showPicker() && this.kind() === 'RECORDED') this.runSearch();
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

  private runSearch(): void {
    this.queries.next({ direction: this.direction(), search: this.search().trim() });
  }

  pick(call: CallRecord): void {
    this.copy(call, this.direction(), null);
  }

  keepSecrets(keep: boolean): void {
    const pending = this.pending();
    if (!pending) return;
    this.copy(pending.call, pending.direction, keep);
  }

  cancelSecrets(): void {
    this.pending.set(null);
  }

  startChange(): void {
    this.changing.set(true);
    if (this.kind() === 'RECORDED') this.runSearch();
  }

  cancelChange(): void {
    this.changing.set(false);
  }

  private copy(call: CallRecord, direction: Direction, keepSecrets: boolean | null): void {
    this.copying.set(true);
    this.error.set(null);
    this.api
      .copyAnswerFromCall({ direction, callId: call.id, keepSecrets })
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
          this.answer.set(answer);
          this.answerChange.emit(answer.id);
          return;
        }
        if (failure?.status === 409) {
          const body = failure.error as SecretsDecisionRequired;
          this.pending.set({ call, direction, secretNames: body?.secretNames ?? [] });
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

  statusOf(call: CallRecord): string {
    return call.response?.status != null ? String(call.response.status) : call.error ? 'failed' : '…';
  }

  sizeText(bytes: number): string {
    return formatBytes(bytes);
  }

  onFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.selectedFile = file;
    this.uploadType.set(file?.type || '');
    this.error.set(null);
  }

  onUploadType(event: Event): void {
    this.uploadType.set((event.target as HTMLInputElement).value);
  }

  upload(): void {
    const file = this.selectedFile;
    if (!file) return;
    if (!this.uploadType().trim()) {
      this.error.set('Say what content type the file is served as, e.g. application/json.');
      return;
    }
    this.uploading.set(true);
    this.error.set(null);
    this.api
      .uploadAnswer(file, this.uploadType().trim(), this.status() ?? null)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (answer) => {
          this.uploading.set(false);
          this.changing.set(false);
          this.answer.set(answer);
          this.answerChange.emit(answer.id);
        },
        error: (failure: HttpErrorResponse) => {
          this.uploading.set(false);
          if (failure.status === 413) {
            const body = failure.error as { limitBytes?: number; sizeBytes?: number };
            this.error.set(
              `That file is ${formatBytes(body?.sizeBytes ?? file.size)}; a stored answer can be at most ${formatBytes(body?.limitBytes ?? 0)}.`
            );
          } else if (failure.status === 415) {
            this.error.set('Say what content type the file is served as, e.g. application/json.');
          } else {
            this.error.set('Could not upload that file. Try again.');
          }
        },
      });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
