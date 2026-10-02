import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { catchError, forkJoin, map, of } from 'rxjs';
import { Comment } from '../../core/models/comment.model';
import { CallInterception, OriginalHttp } from '../../core/models/interception.model';
import { CallEndpointSource, CallRecord } from '../../core/models/call.model';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ResendDialogService } from '../../core/services/resend-dialog.service';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';
import { maskRelive } from '../../shared/utils/relive-mask';
import { setMockResponse } from '../../shared/utils/relive-call-rule';
import { CycleRule, CycleVariable, LiveCall, Step } from '../../shared/utils/relive-types';

/** Above this many bytes stored, the Live calls log shows a size warning with bulk delete
 *  (FR-015c) - `alfred.relive.live-calls.warn-bytes`, sent by the backend with the list; this is
 *  only the fallback for an older backend that does not send it. */
const DEFAULT_WARN_BYTES = 200 * 1024 * 1024;
const UNDO_MS = 8000;

function toOriginalHttp(value: unknown): OriginalHttp | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { status?: unknown; headers?: unknown; body?: unknown };
  return {
    status: typeof v.status === 'number' ? v.status : null,
    headers: (v.headers && typeof v.headers === 'object' ? (v.headers as Record<string, string>) : {}) as Readonly<Record<string, string>>,
    body: typeof v.body === 'string' ? v.body : null,
  };
}

/**
 * The Live calls log (FR-015b/c, T074; mock.html `liveLogPanel()`), in the History tab: every call
 * that actually reached a real system while a run was active, with "Use as recording" (updates the
 * matched step, versioned + undoable, T073), "Mock with it" (writes the live answer into any step's
 * REPLAY mock, mock.html `applyMockWith` - a draft edit, so it's emitted for the host to apply and
 * Save), "Compare" (reuses `InterceptionPanelComponent`, same as the Compare tab, D16), Resend
 * (existing `ResendDialogService`) and Export ▾ (existing `ExportDialogService`) - both need the
 * live call's full CallRecord, which this component only knows by `loggedCallId`, so they resolve it
 * with `CallsApiService.getSummary` + `getDetail` first (T074's own gap-closing addition).
 */
@Component({
  selector: 'app-relive-live-calls',
  standalone: true,
  imports: [DatePipe, InterceptionPanelComponent, ActionMenuComponent],
  templateUrl: './relive-live-calls.component.html',
})
export class ReliveLiveCallsComponent implements OnInit {
  private readonly api = inject(ReliveApiService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly callsApi = inject(CallsApiService);
  private readonly resendDialog = inject(ResendDialogService);
  private readonly exportDialog = inject(ExportDialogService);
  private readonly exportApi = inject(ExportApiService);
  private readonly commentsApi = inject(CommentsApiService);

  readonly cycleId = input.required<string>();
  readonly steps = input<readonly Step[]>([]);
  readonly variables = input<readonly CycleVariable[]>([]);

  /** The host (relive-history → relive-cycle) owns the draft; this component only computes the new
   *  call rule and hands it over, the same way `applyMode` never saves anything itself. */
  readonly mockWith = output<{ readonly stepKey: string; readonly callRule: CycleRule }>();

  readonly calls = signal<readonly LiveCall[]>([]);
  readonly totalBytes = signal(0);
  readonly deleting = signal(false);

  readonly comparingId = signal<string | null>(null);
  readonly compareData = signal<CallInterception | null>(null);

  readonly recordingTarget = signal<{ readonly call: LiveCall; readonly preview: CallInterception } | null>(null);
  readonly undo = signal<{ readonly version: number } | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;

  /** "Mock with it" (mock.html `mockWith`): the live call being applied, while the user is picking
   *  which step's mock it should overwrite. */
  readonly mockWithTarget = signal<LiveCall | null>(null);

  readonly warnBytes = signal(DEFAULT_WARN_BYTES);
  readonly overWarnSize = computed(() => this.totalBytes() > this.warnBytes());

  ngOnInit(): void {
    this.load();
  }

  /** Re-reads the log from the backend - used after a bulk action (e.g. the history delete with
   *  "also delete the calls") removes rows this component already has on screen. */
  reload(): void {
    this.load();
  }

  private load(): void {
    this.api.listLiveCalls(this.cycleId()).subscribe(({ calls, totalBytes, warnBytes }) => {
      this.calls.set(calls);
      this.totalBytes.set(totalBytes);
      if (warnBytes) this.warnBytes.set(warnBytes);
    });
  }

  /** A single view-wide "Reveal secrets" toggle (FR-022a) - never saved, resets whenever the
   *  cycle/steps change (a different cycle's secrets are not this one's to reveal). */
  readonly revealed = signal(false);

  toggleReveal(): void {
    this.revealed.set(!this.revealed());
  }

  private secretNames(): readonly string[] {
    return this.variables().filter((v) => v.secret).map((v) => v.name);
  }

  private secretValues(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.variables().filter((v) => v.secret).map((v) => [v.name, v.value]));
  }

  private mask(text: string | null | undefined): string {
    if (!text) return '';
    return this.revealed() ? text : maskRelive(text, this.secretNames(), this.secretValues());
  }

  private stepOf(stepKey: string | null | undefined): Step | undefined {
    return stepKey ? this.steps().find((s) => s.key === stepKey) : undefined;
  }

  stepLabel(call: LiveCall): string {
    return this.stepOf(call.stepKey)?.label ?? call.stepKey ?? '(unattributed)';
  }

  openCompare(call: LiveCall): void {
    if (this.comparingId() === call.id) {
      this.comparingId.set(null);
      this.compareData.set(null);
      return;
    }
    const step = this.stepOf(call.stepKey);
    if (!step) return;
    this.api.getLiveCall(this.cycleId(), call.id).subscribe((detail) => {
      const rec = step.recording;
      this.comparingId.set(call.id);
      this.compareData.set({
        applied: [],
        originalRequest: { method: rec.method, url: rec.url, headers: rec.requestHeaders, body: this.mask(rec.requestBody) },
        originalResponse: { status: rec.status, headers: rec.responseHeaders, body: this.mask(rec.responseBody) },
        finalRequest: { method: rec.method, url: rec.url, ...this.maskHttp(toOriginalHttp(detail.request)) },
        finalResponse: this.maskHttp(toOriginalHttp(detail.response)),
      });
    });
  }

  private maskHttp(http: OriginalHttp | null): OriginalHttp | null {
    if (!http) return null;
    return { ...http, body: this.mask(http.body) };
  }

  openUseAsRecording(call: LiveCall): void {
    const step = this.stepOf(call.stepKey);
    if (!step) return;
    this.api.getLiveCall(this.cycleId(), call.id).subscribe((detail) => {
      const rec = step.recording;
      const preview: CallInterception = {
        applied: [],
        originalRequest: { method: rec.method, url: rec.url, headers: rec.requestHeaders, body: this.mask(rec.requestBody) },
        originalResponse: { status: rec.status, headers: rec.responseHeaders, body: this.mask(rec.responseBody) },
        finalRequest: { method: rec.method, url: rec.url, ...this.maskHttp(toOriginalHttp(detail.request)) },
        finalResponse: this.maskHttp(toOriginalHttp(detail.response)),
      };
      this.recordingTarget.set({ call, preview });
    });
  }

  cancelUseAsRecording(): void {
    this.recordingTarget.set(null);
  }

  confirmUseAsRecording(): void {
    const target = this.recordingTarget();
    const stepKey = target?.call.stepKey;
    if (!target || !stepKey) return;
    this.api.useAsRecording(this.cycleId(), target.call.id, stepKey).subscribe(() => {
      this.recordingTarget.set(null);
      this.api.listVersions(this.cycleId()).subscribe((versions) => {
        const latest = versions.reduce((max, v) => (!max || v.version > max.version ? v : max), null as (typeof versions)[number] | null);
        if (latest) this.pushUndo(latest.version);
      });
    });
  }

  private pushUndo(version: number): void {
    clearTimeout(this.undoTimer);
    this.undo.set({ version });
    this.undoTimer = setTimeout(() => this.undo.set(null), UNDO_MS);
  }

  undoUseAsRecording(): void {
    const undo = this.undo();
    if (!undo) return;
    clearTimeout(this.undoTimer);
    this.undo.set(null);
    this.api.restoreVersion(this.cycleId(), undo.version).subscribe();
  }

  async remove(call: LiveCall): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(
      `${this.stepLabel(call)} → real supplier (${call.at}). A real supplier answered this - it can't be fetched again without calling it again.`,
      'Delete',
    );
    if (!confirmed) return;
    this.api.deleteLiveCall(this.cycleId(), call.id).subscribe(() => this.load());
  }

  /** A step's own direction tells us which slice logged the underlying call - a live call with no
   *  matching step (e.g. UNEXPECTED) falls back to 'external', the overwhelmingly common case for
   *  this table (outbound children). */
  private sourceOf(call: LiveCall): CallEndpointSource {
    return this.stepOf(call.stepKey)?.direction === 'inbound' ? 'internal' : 'external';
  }

  /** Resolves a live call's `loggedCallId` into a full CallRecord (list-row fields + request/response),
   *  since the Live calls log only ever stored the id, never a summary. */
  private hydratedCall(call: LiveCall) {
    if (!call.loggedCallId) return null;
    const source = this.sourceOf(call);
    return forkJoin({
      summary: this.callsApi.getSummary(call.loggedCallId, source),
      detail: this.callsApi.getDetail(call.loggedCallId, source),
    }).pipe(map(({ summary, detail }) => ({ ...summary, source, ...detail }) as CallRecord));
  }

  openResend(call: LiveCall): void {
    this.hydratedCall(call)?.subscribe((record) => this.resendDialog.open(record, this.cycleId()));
  }

  exportCall(call: LiveCall, format: 'markdown' | 'html' | 'json'): void {
    this.hydratedCall(call)?.subscribe((record) => {
      forkJoin({
        metadata: this.exportApi.fetchMetadata(record).pipe(catchError(() => of(null))),
        comments: this.commentsApi.listForCall(record.id).pipe(catchError(() => of<Comment[]>([]))),
      }).subscribe(({ metadata, comments }) => {
        this.exportDialog.open([record], metadata, new Map([[record.id, comments]]), format);
      });
    });
  }

  /** Steps a live call could be mocked into - any enabled child with a recording (mock.html only
   *  offers steps that have their own Mock response to overwrite). */
  mockableSteps(): readonly Step[] {
    return this.steps().filter((s) => s.parentKey && s.enabled && s.recording);
  }

  openMockWith(call: LiveCall): void {
    this.mockWithTarget.set(call);
  }

  cancelMockWith(): void {
    this.mockWithTarget.set(null);
  }

  applyMockWith(stepKey: string): void {
    const call = this.mockWithTarget();
    const step = this.steps().find((s) => s.key === stepKey);
    if (!call || !step) return;
    const responseBody = typeof (call.response as { body?: unknown } | null)?.body === 'string' ? ((call.response as { body: string }).body) : JSON.stringify(call.response ?? '');
    const callRule = setMockResponse(step.callRule, step.recording, call.status, responseBody);
    this.mockWith.emit({ stepKey, callRule });
    this.mockWithTarget.set(null);
  }

  async deleteAll(): Promise<void> {
    const calls = this.calls();
    if (!calls.length || this.deleting()) return;
    const confirmed = await this.confirmDialog.confirm(`Delete all ${calls.length} live calls? None of them can be fetched again without calling the supplier again.`, 'Delete all');
    if (!confirmed) return;
    this.deleting.set(true);
    let remaining = calls.length;
    calls.forEach((call) =>
      this.api.deleteLiveCall(this.cycleId(), call.id).subscribe(() => {
        remaining -= 1;
        if (remaining === 0) {
          this.deleting.set(false);
          this.load();
        }
      }),
    );
  }
}
