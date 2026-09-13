import { Component, computed, input, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CallTreeNode } from '../../shared/utils/call-tree';
import { CallDiagnostics, CallTiming, analyzeCall, formatMs } from '../../shared/utils/call-diagnostics';
import { uriPath } from '../../shared/utils/call-utils';

/**
 * The "where did the time actually go" panel for one root call.
 *
 * Collapsed it is a single strip: the total, a one-line verdict, and a bar splitting the call into
 * setup / upstream / dead time / post-processing. That alone answers the question a duration and a
 * row of bars cannot - whether the suppliers are the problem, or whether the slow part is your own
 * code before or after them.
 *
 * Expanded it adds the per-call table (with slack, so it is obvious which single call is worth
 * optimising) and the findings list. All of it is derived from timestamps Alfred already has; see
 * call-diagnostics.ts for the arithmetic and why gaps are computed against the union of call
 * windows rather than per pair.
 */
@Component({
  selector: 'app-call-diagnostics',
  standalone: true,
  template: `
    @if (diagnostics(); as d) {
      <div class="diag" [class.open]="open()">
        <button type="button" class="diag-strip" (click)="toggle()" [attr.aria-expanded]="open()">
          <span class="diag-total">{{ ms(d.ledger.durationMs) }}</span>
          @if (verdict(); as v) {
            <span class="diag-verdict" [class]="'diag-' + v.level">{{ v.text }}</span>
          }
          <span class="diag-bar" aria-hidden="true">
            @if (d.ledger.setupMs > 0) {
              <span class="diag-seg diag-setup" [style.width]="pct(d.ledger.setupMs)" [title]="'Setup ' + ms(d.ledger.setupMs)"></span>
            }
            @if (d.ledger.upstreamMs > 0) {
              <span class="diag-seg diag-upstream" [style.width]="pct(d.ledger.upstreamMs)" [title]="'Waiting upstream ' + ms(d.ledger.upstreamMs)"></span>
            }
            @if (d.ledger.betweenMs > 0) {
              <span class="diag-seg diag-between" [style.width]="pct(d.ledger.betweenMs)" [title]="'Dead time between calls ' + ms(d.ledger.betweenMs)"></span>
            }
            @if (d.ledger.tailMs > 0) {
              <span class="diag-seg diag-tail" [style.width]="pct(d.ledger.tailMs)" [title]="'After the last response ' + ms(d.ledger.tailMs)"></span>
            }
          </span>
          <span class="diag-toggle">{{ open() ? '&#9650;' : '&#9660;' }} diagnose</span>
        </button>

        @if (open()) {
          <div class="diag-body">
            <div class="diag-ledger">
              <div class="diag-row diag-row-head"><span>Waiting on suppliers</span><span>{{ ms(d.ledger.upstreamMs) }}</span><span>{{ share(d.ledger.upstreamMs) }}</span></div>
              <div class="diag-row diag-row-head diag-row-split"><span>Inside your app</span><span>{{ ms(d.ledger.unaccountedMs) }}</span><span>{{ share(d.ledger.unaccountedMs) }}</span></div>
              <div class="diag-row"><span class="diag-sub">before the first call</span><span>{{ ms(d.ledger.setupMs) }}</span><span>{{ share(d.ledger.setupMs) }}</span></div>
              <div class="diag-row"><span class="diag-sub">between calls</span><span>{{ ms(d.ledger.betweenMs) }}</span><span>{{ share(d.ledger.betweenMs) }}</span></div>
              <div class="diag-row"><span class="diag-sub">after the last response</span><span>{{ ms(d.ledger.tailMs) }}</span><span>{{ share(d.ledger.tailMs) }}</span></div>
            </div>

            @if (d.timings.length > 0) {
              <table class="diag-table">
                <tr>
                  <th>call</th><th>start</th><th>took</th><th>ended</th><th>slack</th><th></th>
                </tr>
                @for (t of d.timings; track t.call.id) {
                  <tr [class.diag-critical]="t.onCriticalPath" [class.diag-failed]="t.failed">
                    <td class="diag-call">{{ path(t.call) }}</td>
                    <td>+{{ ms(t.offsetMs) }}</td>
                    <td>{{ ms(t.durationMs) }}</td>
                    <td>+{{ ms(t.endMs) }}</td>
                    <td>{{ t.onCriticalPath ? '—' : ms(t.slackMs) }}</td>
                    <td class="diag-note">
                      @if (t.failed) { failed } @else if (t.onCriticalPath) { critical path }
                    </td>
                  </tr>
                  @if (phases(t); as ph) {
                    <!-- WHY the call took what it took, when the proxy measured it. Absent for a
                         call logged before phase timings existed - the row simply doesn't appear,
                         rather than showing zeroes that would read as "measured, and instant". -->
                    <tr class="diag-phase-row">
                      <td colspan="6">
                        <span class="diag-phases" aria-hidden="true">
                          @for (seg of ph.segments; track seg.kind) {
                            <span class="diag-phase" [class]="'diag-phase-' + seg.kind" [style.width]="seg.width" [title]="seg.title"></span>
                          }
                        </span>
                        <span class="diag-phase-legend">{{ ph.summary }}</span>
                      </td>
                    </tr>
                  }
                }
              </table>
            }

            @if (d.parallelism; as p) {
              <div class="diag-parallel">
                {{ p.factor.toFixed(1) }}&times; parallel &middot; up to {{ p.maxConcurrent }} at once &middot;
                {{ ms(p.sumOfDurationsMs) }} of work in {{ ms(d.ledger.upstreamMs) }}
              </div>
            }

            @for (finding of d.findings; track finding.title) {
              <div class="diag-finding" [class]="'diag-' + finding.level">
                <span class="diag-dot" aria-hidden="true"></span>
                <span><b>{{ finding.title }}</b> {{ finding.detail }}</span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class CallDiagnosticsComponent {
  readonly node = input.required<CallTreeNode>();

  readonly open = signal(false);

  readonly diagnostics = computed<CallDiagnostics | null>(() => analyzeCall(this.node()));

  /**
   * The single sentence worth reading without expanding anything. Deliberately taken from the
   * findings rather than recomputed, so the strip can never disagree with the list below it.
   */
  readonly verdict = computed<{ text: string; level: string } | null>(() => {
    const findings = this.diagnostics()?.findings ?? [];
    const problem = findings.find((finding) => finding.level === 'problem');
    if (problem) return { text: problem.title, level: 'problem' };
    const watch = findings.find((finding) => finding.level === 'watch');
    if (watch) return { text: watch.title, level: 'watch' };
    return findings.length > 0 ? { text: findings[0].title, level: findings[0].level } : null;
  });

  toggle(): void {
    this.open.set(!this.open());
  }

  ms(value: number): string {
    return formatMs(value);
  }

  share(value: number): string {
    const total = this.diagnostics()?.ledger.durationMs ?? 0;
    return total > 0 ? `${Math.round((value / total) * 100)}%` : '';
  }

  pct(value: number): string {
    const total = this.diagnostics()?.ledger.durationMs ?? 0;
    return total > 0 ? `${((value / total) * 100).toFixed(2)}%` : '0%';
  }

  path(call: CallRecord): string {
    return uriPath(call.url);
  }

  /**
   * Splits one call's duration into the phases the proxy measured, plus a plain-English summary of
   * which one dominates - the sentence is the point, the bar just shows the proportions.
   *
   * Returns null when nothing was measured. Connect and TLS are normally absent because the
   * connection was reused, which is the healthy case and is said so explicitly; their PRESENCE is
   * the finding, since paying for a handshake on every call means connections aren't being pooled.
   */
  phases(timing: CallTiming): { segments: PhaseSegment[]; summary: string } | null {
    const measured = timing.call.timing;
    if (!measured) return null;

    const total = timing.durationMs || 1;
    const connect = measured.connect_ms ?? 0;
    const tls = measured.tls_ms ?? 0;
    // Connect and TLS happen INSIDE the time-to-first-byte window, not before it - mitmproxy opens
    // the upstream connection lazily, after the request hook has already fired. Treating all four
    // as consecutive segments double-counts the handshake: measured live, connect 74.5 + TLS 57.0
    // + TTFB 193.8 + download 2.8 came to 328ms for a call that took 196.6ms, a bar 167% wide.
    // Subtracting leaves the upstream's own think time, and the four then sum to the duration.
    const thinking = Math.max(0, (measured.ttfb_ms ?? 0) - connect - tls);
    const parts: { kind: string; value: number; label: string }[] = [
      { kind: 'connect', value: connect, label: 'connect' },
      { kind: 'tls', value: tls, label: 'TLS' },
      { kind: 'ttfb', value: thinking, label: 'upstream thinking' },
      { kind: 'download', value: measured.download_ms ?? 0, label: 'download' },
    ].filter((part) => part.value > 0);
    if (parts.length === 0) return null;

    const segments = parts.map((part) => ({
      kind: part.kind,
      width: `${((part.value / total) * 100).toFixed(2)}%`,
      title: `${part.label} ${formatMs(part.value)}`,
    }));

    const biggest = parts.reduce((best, part) => (part.value > best.value ? part : best));
    const handshake = connect + tls;
    const summary =
      handshake / total >= 0.3
        ? `${Math.round((handshake / total) * 100)}% of this call is connect and TLS - the connection is not being reused`
        : `mostly ${biggest.label} (${formatMs(biggest.value)})${measured.reused_connection ? ', on a reused connection' : ''}`;

    return { segments, summary };
  }
}

interface PhaseSegment {
  readonly kind: string;
  readonly width: string;
  readonly title: string;
}
