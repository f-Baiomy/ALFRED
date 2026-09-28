import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { CallInterception, OriginalHttp } from '../../core/models/interception.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';
import { maskRelive } from '../../shared/utils/relive-mask';
import { CycleVariable, LiveCall, Step } from '../../shared/utils/relive-types';

/** Above this many bytes stored, the Live calls log shows a size warning with bulk delete
 *  (FR-015c) - `alfred.relive.live-calls.warn-bytes`, no settings endpoint exposes it yet, so this
 *  mirrors the backend's own default (200 MB). */
const WARN_BYTES = 200 * 1024 * 1024;
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
 * matched step, versioned + undoable, T073) and "Compare" (reuses `InterceptionPanelComponent`,
 * same as the Compare tab, D16). "Mock with it", Resend and Export are left for a later pass - each
 * needs its own picker/wiring beyond this table.
 */
@Component({
  selector: 'app-relive-live-calls',
  standalone: true,
  imports: [InterceptionPanelComponent],
  templateUrl: './relive-live-calls.component.html',
})
export class ReliveLiveCallsComponent implements OnInit {
  private readonly api = inject(ReliveApiService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly cycleId = input.required<string>();
  readonly steps = input<readonly Step[]>([]);
  readonly variables = input<readonly CycleVariable[]>([]);

  readonly calls = signal<readonly LiveCall[]>([]);
  readonly totalBytes = signal(0);
  readonly deleting = signal(false);

  readonly comparingId = signal<string | null>(null);
  readonly compareData = signal<CallInterception | null>(null);

  readonly recordingTarget = signal<{ readonly call: LiveCall; readonly preview: CallInterception } | null>(null);
  readonly undo = signal<{ readonly version: number } | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;

  readonly overWarnSize = computed(() => this.totalBytes() > WARN_BYTES);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.listLiveCalls(this.cycleId()).subscribe(({ calls, totalBytes }) => {
      this.calls.set(calls);
      this.totalBytes.set(totalBytes);
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
