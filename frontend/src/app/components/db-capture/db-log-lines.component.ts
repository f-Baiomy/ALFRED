import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { LinkedLogLine, LogMatch } from '../../core/models/call-logs.model';
import { TogetherRow, lineFields, logLevelClass } from '../../shared/utils/call-log-rows';

/**
 * The database window's Logs and Together lists (specs/008-logs-call-link, walkthrough "Together" and "Logs + a
 * line"): one row per log line - offset from the call's start, level, message, its source when the project has
 * several - and, in Together, the call's statements and supplier calls between them by time. A log line opens to
 * every field of the line with "Open in Logs ↗" to see it among its neighbours; a statement row jumps to it.
 */
@Component({
  standalone: true,
  selector: 'app-db-log-lines',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dll">
      @for (r of rows(); track r.key) {
        @switch (r.kind) {
          @case ('log') {
            <div class="dll-r log" [class.err]="lv(r.line.level) === 'error'" [class.open]="opened().has(r.key)" role="button" tabindex="0"
                 (click)="toggle(r.key)" (keydown.enter)="toggle(r.key)">
              <span class="at">{{ at(r.atMs) }}</span>
              <span [class]="'v lv-' + lv(r.line.level)">▤ {{ r.line.level ?? 'LOG' }}</span>
              <span class="t" [title]="r.line.message">@if (multiSource()) {<span class="src">{{ r.line.sourceName }}</span>}{{ r.line.message }}</span>
              <span class="how">@if (r.line.kept) {<span class="pill kept" title="Alfred's own copy - kept with the cycle or import">kept</span>}<span class="pill" [class.exact]="r.line.matchedBy === 'EXACT'">{{ how(r.line.matchedBy) }}</span></span>
              <span class="ms"></span>
            </div>
            @if (opened().has(r.key)) {
              <div class="dll-detail">
                @if (fieldsOf(r.line); as fs) {
                  <div class="kv">@for (f of fs; track f.key) {<span>{{ f.key }}</span><span>{{ f.value }}</span>}</div>
                } @else {
                  <pre class="raw">{{ r.line.raw }}</pre>
                }
                <div class="foot">
                  @if (!r.line.kept) {
                    <a [href]="logsLink(r.line)" target="_blank" rel="noopener">Open in Logs ↗</a> ·
                  }
                  {{ r.line.sourceName }} · matched by <span class="pill" [class.exact]="r.line.matchedBy === 'EXACT'">{{ how(r.line.matchedBy) }}</span>
                  @if (r.line.thread) { · thread {{ r.line.thread }}}
                  @if (r.line.logger) { · {{ r.line.logger }}}
                </div>
              </div>
            }
          }
          @case ('db') {
            <div class="dll-r db" [class.err]="r.failed" role="button" tabindex="0" title="Show this statement" (click)="jump.emit(r.seq)" (keydown.enter)="jump.emit(r.seq)">
              <span class="at">{{ at(r.atMs) }}</span><span class="v vdb">{{ r.verb }}</span><span class="t" [title]="r.text">{{ r.text }}</span>
              <span class="how">#{{ r.seq }}</span><span class="ms">{{ ms(r.ms) }}</span>
            </div>
          }
          @case ('sup') {
            <div class="dll-r sup" role="button" tabindex="0" title="Show this supplier call" (click)="jump.emit(r.seq)" (keydown.enter)="jump.emit(r.seq)">
              <span class="at">{{ at(r.atMs) }}</span><span class="v vsup">{{ r.verb }}</span><span class="t" [title]="r.text">{{ r.text }}</span>
              <span class="how">supplier</span><span class="ms">{{ r.ms != null ? ms(r.ms) : '' }}</span>
            </div>
          }
        }
      }
    </div>
  `,
})
export class DbLogLinesComponent {
  readonly rows = input.required<readonly TogetherRow[]>();
  /** Show each line's source name (the project reads more than one log source). */
  readonly multiSource = input(false);
  /** A statement or supplier row was clicked: its seq. */
  readonly jump = output<number>();

  readonly opened = signal<ReadonlySet<string>>(new Set());
  /** A line's fields, parsed once per line. */
  private readonly fieldCache = new Map<string, ReturnType<typeof lineFields>>();

  toggle(key: string): void {
    this.opened.update((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  }

  fieldsOf(line: LinkedLogLine): ReturnType<typeof lineFields> {
    const cache = this.fieldCache;
    const key = `${line.sourceId}:${line.lineId}`;
    if (!cache.has(key)) cache.set(key, lineFields(line.raw));
    return cache.get(key)!;
  }

  lv(level: string | null): string {
    return logLevelClass(level);
  }

  how(m: LogMatch): string {
    return m === 'EXACT' ? 'exact' : 'same thread + time';
  }

  logsLink(line: LinkedLogLine): string {
    return `/logs/${encodeURIComponent(line.sourceId)}?line=${encodeURIComponent(line.lineId)}`;
  }

  at(ms: number): string {
    const sign = ms < 0 ? '−' : '+';
    const a = Math.abs(ms);
    return sign + (a >= 1000 ? `${(a / 1000).toFixed(2)} s` : `${Math.round(a)} ms`);
  }

  ms(v: number): string {
    return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
  }
}
