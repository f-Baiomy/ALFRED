import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin, map, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { directionOf } from '../../core/models/call-ref.model';
import { BulkResendDialogService, DraftResult } from '../../core/services/bulk-resend-dialog.service';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { buildMatcher, literalReplacement, matcherError } from '../../shared/utils/find-replace';
import {
  ResendDraft,
  countMatches,
  describeEdits,
  draftFrom,
  findReplaceAll,
  isEdited,
  moveDraft,
  removeHeaderFromAll,
  resetDraft,
  setCurrentSessionOnAll,
  setHeaderOnAll,
  setHostOnAll,
  setMethodOnAll,
} from '../../shared/utils/resend-draft';
import { ResendCallEditorComponent } from '../resend-call-editor/resend-call-editor.component';
import { ResendPanelComponent } from '../resend-panel/resend-panel.component';

const PICK_REQUESTER = 'bulk-resend';

/**
 * The multi-call resend editor behind "Resend selected…": the calls in send order (drag, arrows,
 * untick to skip), each fully editable on its own, tools that edit every ticked call at once, and
 * the send itself (one at a time, stop-at-first-failure switch, delay between sends).
 *
 * State lives in BulkResendDialogService so it survives this dialog hiding while "Add calls from
 * anywhere…" sends the user to other tabs, and so a send keeps going if the dialog is closed.
 * Mounted once, in the main layout.
 */
@Component({
  selector: 'app-bulk-resend-dialog',
  standalone: true,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, ResendCallEditorComponent, ResendPanelComponent],
  templateUrl: './bulk-resend-dialog.component.html',
})
export class BulkResendDialogComponent {
  readonly service = inject(BulkResendDialogService);
  private readonly picker = inject(CallPickerService);
  private readonly refDetail = inject(CallRefDetailService);
  private readonly callsApi = inject(CallsApiService);
  private readonly router = inject(Router);

  readonly mode = signal<'call' | 'all'>('call');
  readonly selectedKey = signal<string | null>(null);
  readonly stopOnFailure = signal(true);
  readonly delayMs = signal(0);
  readonly notice = signal<string | null>(null);

  // Edit all at once
  readonly headerName = signal('');
  readonly headerValue = signal('');
  readonly find = signal('');
  readonly replace = signal('');
  readonly regex = signal(false);
  readonly matchCase = signal(false);
  readonly inUrl = signal(true);
  readonly inHeaders = signal(true);
  readonly inBody = signal(true);
  readonly method = signal('');
  readonly host = signal('');

  /** The resent call, fetched when "View the cycle" is pressed on a result, keyed by draft. */
  readonly journeys = signal<Readonly<Record<string, CallRecord | 'loading' | 'missing'>>>({});

  readonly drafts = this.service.drafts;
  readonly included = computed(() => this.drafts().filter((d) => d.include));
  readonly editedCount = computed(() => this.drafts().filter(isEdited).length);

  readonly selected = computed(() => {
    const key = this.selectedKey();
    return this.drafts().find((d) => d.key === key) ?? this.drafts()[0] ?? null;
  });

  private readonly matcher = computed(() => buildMatcher(this.find(), { regex: this.regex(), matchCase: this.matchCase() }));
  readonly findError = computed(() => (this.find() ? matcherError(this.find(), { regex: this.regex(), matchCase: this.matchCase() }) : null));
  readonly matchCount = computed(() =>
    countMatches(this.drafts(), this.matcher(), { inUrl: this.inUrl(), inHeaders: this.inHeaders(), inBody: this.inBody() })
  );

  constructor() {
    // Return from "Add calls from anywhere…" - the dialog stayed mounted, so react here.
    effect(() => {
      if (!this.picker.hasResult(PICK_REQUESTER)) return;
      untracked(() => {
        const result = this.picker.takeResult(PICK_REQUESTER);
        this.service.hidden.set(false);
        const picked = result?.picked ?? [];
        if (picked.length === 0) return;
        forkJoin(picked.map((p) => this.refDetail.hydrate(p.ref, p.call).pipe(map((call) => draftFrom(call, p.ref.cycleId)), catchError(() => of(null)))))
          .subscribe((drafts) => {
            const added = drafts.filter((d): d is ResendDraft => d !== null);
            this.service.append(added);
            this.notice.set(`${added.length} call${added.length === 1 ? '' : 's'} added${added.length < picked.length ? ` · ${picked.length - added.length} could not be loaded` : ''}.`);
          });
      });
    });
  }

  resultOf(draft: ResendDraft): DraftResult | null {
    return this.service.results()[draft.key] ?? null;
  }

  isEdited = isEdited;
  describeEdits = describeEdits;

  select(draft: ResendDraft): void {
    this.selectedKey.set(draft.key);
    this.mode.set('call');
  }

  updateDraft(next: ResendDraft): void {
    this.service.drafts.update((all) => all.map((d) => (d.key === next.key ? next : d)));
  }

  toggleInclude(draft: ResendDraft, event: Event): void {
    event.stopPropagation();
    this.updateDraft({ ...draft, include: (event.target as HTMLInputElement).checked });
  }

  move(index: number, delta: number, event: Event): void {
    event.stopPropagation();
    this.service.drafts.set(moveDraft(this.drafts(), index, index + delta));
  }

  drop(event: CdkDragDrop<readonly ResendDraft[]>): void {
    this.service.drafts.set(moveDraft(this.drafts(), event.previousIndex, event.currentIndex));
  }

  remove(draft: ResendDraft, event: Event): void {
    event.stopPropagation();
    this.service.drafts.update((all) => all.filter((d) => d.key !== draft.key));
  }

  reset(draft: ResendDraft): void {
    this.updateDraft(resetDraft(draft));
  }

  // ---- edit all at once ----

  private apply(drafts: ResendDraft[], message: string): void {
    this.service.drafts.set(drafts);
    this.notice.set(message);
  }

  setHeader(): void {
    const name = this.headerName().trim();
    if (!name) return;
    this.apply(setHeaderOnAll(this.drafts(), name, this.headerValue()), `${name} set on ${this.included().length} calls.`);
  }

  removeHeader(): void {
    const name = this.headerName().trim();
    if (!name) return;
    this.apply(removeHeaderFromAll(this.drafts(), name), `${name} removed from ${this.included().length} calls.`);
  }

  replaceAll(): void {
    const count = this.matchCount();
    if (!count) return;
    this.apply(
      // Plain mode means plain on both sides: a "$1" typed as the replacement is text, not a group.
      findReplaceAll(this.drafts(), this.matcher(), this.regex() ? this.replace() : literalReplacement(this.replace()), {
        inUrl: this.inUrl(),
        inHeaders: this.inHeaders(),
        inBody: this.inBody(),
      }),
      `${count} match${count === 1 ? '' : 'es'} replaced.`
    );
  }

  applyMethodAndHost(): void {
    let drafts = this.drafts() as ResendDraft[];
    const parts: string[] = [];
    if (this.method().trim()) {
      drafts = setMethodOnAll(drafts, this.method());
      parts.push(`method ${this.method().trim().toUpperCase()}`);
    }
    if (this.host().trim()) {
      const result = setHostOnAll(drafts, this.host());
      drafts = result.drafts;
      parts.push(`host ${this.host().trim()}${result.skipped ? ` (${result.skipped} inbound left alone)` : ''}`);
    }
    if (parts.length) this.apply(drafts, `Set ${parts.join(' and ')}.`);
  }

  setSessionOnAll(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.apply(setCurrentSessionOnAll(this.drafts(), on), on ? 'Current session on for every ticked call.' : 'Current session off.');
  }

  text(signalSetter: (value: string) => void, event: Event): void {
    signalSetter((event.target as HTMLInputElement).value);
  }

  checked(signalSetter: (value: boolean) => void, event: Event): void {
    signalSetter((event.target as HTMLInputElement).checked);
  }

  onDelay(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.delayMs.set(Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value)), 60_000) : 0);
  }

  // ---- send / pick / close ----

  send(): void {
    this.notice.set(null);
    this.journeys.set({});
    this.service.send({ stopOnFailure: this.stopOnFailure(), delayMs: this.delayMs() });
  }

  addFromAnywhere(): void {
    this.picker.start({
      requester: PICK_REQUESTER,
      title: 'Calls to add to the resend',
      mode: 'multi',
      returnUrl: this.router.url,
      returnLabel: 'the resend editor',
      refuse: this.drafts().map((d) => ({ ref: d.ref, reason: 'Already in this resend' })),
    });
    this.service.hidden.set(true);
  }

  close(): void {
    this.service.close();
  }

  /** Loads the resent call and shows its whole cycle (the Resent panel) under the result. */
  viewCycle(draft: ResendDraft): void {
    const result = this.resultOf(draft);
    if (!result?.newCallId) return;
    if (this.journeys()[draft.key]) {
      const { [draft.key]: _closed, ...rest } = this.journeys();
      this.journeys.set(rest);
      return;
    }
    const id = result.newCallId;
    const source = draft.ref.source;
    this.journeys.update((all) => ({ ...all, [draft.key]: 'loading' }));
    this.callsApi
      .getCalls({ search: '', supplier: '', sort: 'newest', offset: 0, limit: 5, sessionId: '', operationId: '', requestId: id }, source)
      .pipe(
        map((page) => page.calls.find((c) => c.id === id) ?? null),
        catchError(() => of(null))
      )
      .subscribe((call) => this.journeys.update((all) => ({ ...all, [draft.key]: call ?? 'missing' })));
  }

  journeyOf(draft: ResendDraft): CallRecord | 'loading' | 'missing' | null {
    return this.journeys()[draft.key] ?? null;
  }

  asCall(value: CallRecord | 'loading' | 'missing' | null): CallRecord | null {
    return value && typeof value === 'object' ? value : null;
  }

  hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  pathOf(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  originOf(draft: ResendDraft): string {
    const where = draft.ref.cycleId ? 'cycle' : 'live';
    return `${directionOf(draft.ref)} · ${where}`;
  }

  newCallHref(result: DraftResult): string {
    return `/?requestId=${encodeURIComponent(result.newCallId ?? '')}`;
  }
}
