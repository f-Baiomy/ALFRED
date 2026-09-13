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

  readonly isCritical = (timing: CallTiming) => timing.onCriticalPath;
}
