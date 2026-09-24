import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { RuleSource, SecretsDecisionRequired, StoredAnswer } from '../../core/models/interception.model';
import { InterceptionApiService } from '../../core/services/interception-api.service';
import { CallFinderComponent, FoundCall } from '../call-finder/call-finder.component';
import { StatusPickerComponent } from '../status-picker/status-picker.component';

type Direction = 'outbound' | 'inbound';

/** A call picked whose response carries secrets - waiting for keep or strip. */
interface PendingSecrets {
  readonly callId: string;
  readonly direction: Direction;
  readonly cycleId: string | null;
  readonly secretNames: readonly string[];
}

/** A call to copy the moment the picker opens - "Use as answer in a new rule…" on a card, or a call picked from anywhere. */
export interface AnswerPreselect {
  readonly direction: Direction;
  readonly callId: string;
  /** Set when the call was picked from a session cycle - its captured copy, which can outlive the live log. */
  readonly cycleId?: string | null;
}

/**
 * Picks the logged call a stored-answer action answers with, and shows the stored copy once one
 * exists.
 *
 * Finding the call is CallFinderComponent's job (search tokens, chips, rule narrowing, preview,
 * Load more, Pick from anywhere); choosing one here makes the copy at once - not on save - so the
 * rule keeps working after the original call has been evicted from the log. A response that
 * carries secret headers is never stored on the user's behalf either way: the backend answers 409
 * with their names and this asks, with no default, before retrying with the choice (FR-026).
 */
@Component({
  selector: 'app-answer-picker',
  standalone: true,
  imports: [StatusPickerComponent, CallFinderComponent],
  templateUrl: './answer-picker.component.html',
})
export class AnswerPickerComponent implements OnInit {
  private readonly api = inject(InterceptionApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly answerId = input<string | null | undefined>(null);
  /** ANSWER_WITH_FILE: the answer comes from an upload, so the picker shows a file input instead of a call search. */
  readonly uploadMode = input<boolean>(false);
  /** The rule being edited - passed to the finder, whose list it narrows until "Matches this rule" is switched off. */
  readonly ruleHost = input<string>('');
  readonly rulePath = input<string>('');
  readonly ruleMethods = input<readonly string[]>([]);
  readonly ruleSource = input<RuleSource>('both');
  readonly ruleServiceNames = input<readonly string[]>([]);
  readonly preselect = input<AnswerPreselect | null>(null);
  /** Emits the new stored answer's id - the rule editor writes it onto the action. */
  readonly answerChange = output<string>();
  /** "Pick from anywhere…" - the host parks its own state and starts CallPickerService; this component is about to be destroyed. */
  readonly pickAnywhere = output<void>();

  readonly uploadFile = signal<File | null>(null);
  readonly uploadContentType = signal('');
  readonly uploadStatus = signal<number | null>(null);

  readonly copying = signal(false);
  readonly error = signal<string | null>(null);
  readonly pending = signal<PendingSecrets | null>(null);
  readonly answer = signal<StoredAnswer | null>(null);
  /** True while an attached answer is being replaced - the finder shows instead of the card. */
  readonly changing = signal(false);

  readonly showPicker = computed(() => this.changing() || !this.answerId());

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
    const preselect = this.preselect();
    // Wins over an attached answer: a pick made on another tab is an explicit "answer with this instead".
    if (preselect) {
      this.copy(preselect.callId, preselect.direction, null, preselect.cycleId ?? null);
    }
  }

  /** The finder's choice - copied into a stored answer at once. */
  onChosen(found: FoundCall): void {
    this.copy(found.call.id, found.direction, null);
  }

  keepSecrets(keep: boolean): void {
    const pending = this.pending();
    if (!pending) return;
    this.copy(pending.callId, pending.direction, keep, pending.cycleId);
  }

  cancelSecrets(): void {
    this.pending.set(null);
  }

  startChange(): void {
    this.changing.set(true);
  }

  cancelChange(): void {
    this.changing.set(false);
  }

  private copy(callId: string, direction: Direction, keepSecrets: boolean | null, cycleId: string | null = null): void {
    this.copying.set(true);
    this.error.set(null);
    this.api
      .copyAnswerFromCall({ direction, callId, cycleId, keepSecrets })
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
          this.pending.set({ callId, direction, cycleId, secretNames: body?.secretNames ?? [] });
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

  sizeText(bytes: number): string {
    return formatBytes(bytes);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
