import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { LinkedLogLine, LogMatch } from '../../core/models/call-logs.model';
import { TogetherRow, lineFields, logLevelClass } from '../../shared/utils/call-log-rows';
import { DbLogRowComponent } from './db-log-row.component';

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
  imports: [DbLogRowComponent],
  template: `
    <div class="dll">
      @for (r of rows(); track r.key) {
        @switch (r.kind) {
          @case ('log') {
            <app-db-log-row [line]="r.line" [atMs]="r.atMs" [showSource]="multiSource()" />
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
    return m === 'CAUGHT' ? 'caught' : m === 'EXACT' ? 'exact' : 'same thread + time';
  }

  /** "com.tt.nc.FlightSearchService" → "FlightSearchService" - the full name is in the line's detail. */
  shortLogger(logger: string): string {
    return logger.slice(logger.lastIndexOf('.') + 1);
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
