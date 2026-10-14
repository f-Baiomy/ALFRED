import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MentionRef } from '../../../core/models/board.models';
import { CallDetail } from '../../../core/models/call.model';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { CallLogsApiService } from '../../../core/services/call-logs-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { SnippetDataService } from '../../../core/services/snippet-data.service';
import { detectBodyKind, formatBody } from '../../../shared/utils/body-format';
import { callOf } from '../../../shared/utils/mention-syntax';

/**
 * `!@[call:…]` alone on a line (specs/017 R20): the call opened in place - status, time, its database statements and
 * caught log lines counted, and its headers and bodies to unfold. ↗ opens it in the Calls view as a mention does.
 */
@Component({
  selector: 'app-call-view',
  standalone: true,
  template: `
    <div class="board-vis board-callview" dir="ltr">
      <div class="board-vis-bar"><span class="board-callview-title" [class.bad]="bad()">{{ mention().label }}</span>
        <button type="button" class="board-link" title="Open in Calls" (click)="open()">↗ Open</button></div>
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      <div class="board-callview-facts">
        @if (status() !== null) { <span [class]="bad() ? 'c-red' : 'c-green'">{{ status() }}</span> }
        @if (counts(); as c) {
          @if (c.statements !== null) { <span>◆ {{ c.statements }} SQL{{ c.failed ? ' · ' + c.failed + ' failed' : '' }}{{ c.dbMs !== null ? ' · ' + c.dbMs + ' ms in DB' : '' }}</span> }
          @if (c.errors !== null) { <span [class.c-red]="c.errors > 0">▤ {{ c.errors }} error{{ c.errors === 1 ? '' : 's' }} · {{ c.warnings }} warning{{ c.warnings === 1 ? '' : 's' }}</span> }
        }
      </div>
      @if (detail(); as d) {
        <details class="board-callview-part"><summary>Request headers ({{ count(d.request?.headers) }})</summary><pre class="board-vis-src">{{ headers(d.request?.headers) }}</pre></details>
        @if (d.request?.body) { <details class="board-callview-part"><summary>Request body</summary><pre class="board-vis-src">{{ body(d.request?.body) }}</pre></details> }
        <details class="board-callview-part"><summary>Response headers ({{ count(d.response?.headers) }})</summary><pre class="board-vis-src">{{ headers(d.response?.headers) }}</pre></details>
        @if (d.response?.body) { <details class="board-callview-part"><summary>Response body</summary><pre class="board-vis-src">{{ body(d.response?.body) }}</pre></details> }
      } @else if (!error()) { <div class="board-dim board-query-empty">Reading the call…</div> }
    </div>`,
})
export class CallViewComponent implements OnInit {
  readonly mention = input.required<MentionRef>();

  private readonly data = inject(SnippetDataService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly mentions = inject(BoardMentionsService);
  readonly detail = signal<CallDetail | null>(null);
  readonly counts = signal<{ statements: number | null; failed: number; dbMs: number | null; errors: number | null; warnings: number } | null>(null);
  readonly error = signal<string | null>(null);
  readonly status = computed(() => this.detail()?.response?.status ?? (/\b([1-5]\d\d)\b/.exec(this.mention().label)?.[1] ?? null));
  readonly bad = computed(() => /^[45]/.test(String(this.status() ?? '')) || /error|exception|fail/i.test(this.mention().label));

  async ngOnInit(): Promise<void> {
    const c = callOf(this.mention());
    if (!c) { this.error.set('Not a call'); return; }
    try {
      this.detail.set(await this.data.read('call', { ref: this.mention().ref }) as CallDetail);
    } catch {
      this.error.set('This call is no longer kept');
      return;
    }
    if (c.direction !== 'in') return;
    const [db, logs] = await Promise.all([
      firstValueFrom(this.db.summaries([c.id])).catch(() => ({} as Record<string, never>)),
      firstValueFrom(this.logs.counts([c.id], c.cycleId)).catch(() => ({} as Record<string, never>)),
    ]);
    const s = (db as Record<string, { statementCount: number; failedCount: number; dbMicros: number }>)[c.id];
    const l = (logs as Record<string, { errors: number; warnings: number }>)[c.id];
    this.counts.set({ statements: s ? s.statementCount : null, failed: s?.failedCount ?? 0, dbMs: s ? Math.round(s.dbMicros / 1000) : null,
      errors: l ? l.errors : null, warnings: l?.warnings ?? 0 });
  }

  open(): void {
    this.mentions.open(this.mention());
  }

  count(h: Readonly<Record<string, string>> | undefined): number {
    return h ? Object.keys(h).length : 0;
  }

  headers(h: Readonly<Record<string, string>> | undefined): string {
    return h ? Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
  }

  /** Bodies in full (exports and views never cut call data), JSON laid out. */
  body(b: string | undefined): string {
    if (!b) return '';
    return formatBody(b, detectBodyKind(b)) ?? b;
  }
}
