import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { LinkedLogLine, LogMatch } from '../../core/models/call-logs.model';
import { lineFields, logLevelClass } from '../../shared/utils/call-log-rows';

/**
 * One log line of a call - offset, level, logger, message - opening to its logger, thread, message and exception. The
 * one row both the Logs list and the statement tree (Together) render, so the two never drift apart.
 */
@Component({
  standalone: true,
  selector: 'app-db-log-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dll-r log" [class.err]="lv() === 'error'" [class.open]="open()" role="button" tabindex="0" [attr.data-seq]="line().seq ?? null"
         (click)="open.set(!open())" (keydown.enter)="open.set(!open())">
      <span class="at">{{ at(atMs()) }}</span>
      <span [class]="'v lv-' + lv()">▤ {{ line().level ?? 'LOG' }}</span>
      <span class="t" [title]="line().message">@if (showSource()) {<span class="src">{{ line().sourceName }}</span>}@if (line().matchedBy === 'CAUGHT' && line().logger) {<span class="src">{{ shortLogger(line().logger!) }}</span>}{{ line().message }}@if (line().exception) {<span class="exm"> ⚠ {{ line().exception!.type }}</span>}</span>
      <span class="how">@if (line().kept) {<span class="pill kept" title="Alfred's own copy - kept with the cycle or import">kept</span>}<span class="pill" [class.exact]="line().matchedBy !== 'THREAD_TIME'">{{ how(line().matchedBy) }}</span></span>
      <span class="ms"></span>
    </div>
    @if (open()) {
      <div class="dll-detail">
        @if (line().matchedBy === 'CAUGHT') {
          <div class="kv"><span>logger</span><span>{{ line().logger }}</span><span>thread</span><span>{{ line().thread }}</span>
            <span>message</span><span>{{ line().message }}</span></div>
          @if (line().exception; as ex) {
            <div class="dll-ex"><b>{{ ex.type }}</b>@if (ex.message) {: {{ ex.message }}}<pre>{{ ex.stack }}</pre></div>
          }
        } @else {
          @if (fields(); as fs) {
            <div class="kv">@for (f of fs; track f.key) {<span>{{ f.key }}</span><span>{{ f.value }}</span>}</div>
          } @else {
            <pre class="raw">{{ line().raw }}</pre>
          }
        }
        <div class="foot">
          @if (!line().kept && line().sourceId !== 'agent') {
            <a [href]="logsLink()" target="_blank" rel="noopener">Open in Logs ↗</a> ·
          }
          {{ line().sourceName }} · matched by <span class="pill" [class.exact]="line().matchedBy !== 'THREAD_TIME'">{{ how(line().matchedBy) }}</span>
          @if (line().thread) { · thread {{ line().thread }}}
          @if (line().logger) { · {{ line().logger }}}
        </div>
      </div>
    }
  `,
})
export class DbLogRowComponent {
  readonly line = input.required<LinkedLogLine>();
  /** Milliseconds from the call's start (or from the thread's first line, outside any call). */
  readonly atMs = input.required<number>();
  /** Show the line's source name (several sources). */
  readonly showSource = input(false);

  readonly open = signal(false);

  lv(): string {
    return logLevelClass(this.line().level);
  }

  fields(): ReturnType<typeof lineFields> {
    return lineFields(this.line().raw);
  }

  how(m: LogMatch): string {
    return m === 'CAUGHT' ? 'caught' : m === 'EXACT' ? 'exact' : 'same thread + time';
  }

  /** "com.tt.nc.FlightSearchService" → "FlightSearchService" - the full name is in the line's detail. */
  shortLogger(logger: string): string {
    return logger.slice(logger.lastIndexOf('.') + 1);
  }

  logsLink(): string {
    return `/logs/${encodeURIComponent(this.line().sourceId)}?line=${encodeURIComponent(this.line().lineId)}`;
  }

  at(ms: number): string {
    const sign = ms < 0 ? '−' : '+';
    const a = Math.abs(ms);
    return sign + (a >= 1000 ? `${(a / 1000).toFixed(2)} s` : `${Math.round(a)} ms`);
  }
}
