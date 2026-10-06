import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { LineCall } from '../../core/models/call-logs.model';
import { CallFocusService } from '../../core/services/call-focus.service';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { DbWindowService } from '../db-capture/db-window.service';

/**
 * "During call ↗ POST /…/search · 200 · 20.0 s · same thread + time" on an opened Logs-tab line
 * (specs/008-logs-call-link, walkthrough "From a log line"): the inbound call the line was written during, with links to
 * the call in Live calls and to its database window. Shows nothing when no call of a project with ▤ on fits.
 */
@Component({
  standalone: true,
  selector: 'app-log-line-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (found(); as f) {
      <div class="lg-during">
        <span class="lbl">During call</span>
        <b>{{ f.call.method }}</b> <span class="u" [title]="f.call.url">{{ path(f.call.url) }}</span>
        @if (f.call.status != null) {<span>· {{ f.call.status }}</span>}
        <span>· {{ ms(f.call.durationMs) }}</span>
        @if (f.call.service) {<span>· {{ f.call.service }}</span>}
        <span class="pill" [class.exact]="f.matchedBy === 'EXACT'">{{ f.matchedBy === 'EXACT' ? 'exact' : 'same thread + time' }}</span>
        <a (click)="openCall(f)">open the call ↗</a>
        <a (click)="openWindow(f)">its database &amp; logs ↗</a>
      </div>
    }
  `,
})
export class LogLineCallComponent implements OnInit {
  private readonly api = inject(CallLogsApiService);
  private readonly focus = inject(CallFocusService);
  private readonly windows = inject(DbWindowService);

  readonly sourceId = input.required<string>();
  readonly lineId = input.required<string>();
  readonly found = signal<LineCall | null>(null);

  ngOnInit(): void {
    this.api.forLine(this.sourceId(), this.lineId()).subscribe({ next: (c) => this.found.set(c ?? null), error: () => this.found.set(null) });
  }

  openCall(f: LineCall): void {
    this.focus.go({ callId: f.call.id, cycleId: null, direction: 'inbound', serviceName: f.call.service });
  }

  openWindow(f: LineCall): void {
    const call: CallRecord = {
      id: f.call.id, original_url: f.call.url, url: f.call.url, method: f.call.method, timestamp: f.call.at, duration_ms: f.call.durationMs,
      source: 'internal', service_name: f.call.service ?? undefined,
    } as CallRecord;
    this.windows.openCall(call, 'together');
  }

  path(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  ms(v: number): string {
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  }
}
