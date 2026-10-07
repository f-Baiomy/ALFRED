import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KeyPatternRow } from '../../core/models/store-command.model';
import { msText } from '../../shared/utils/db-statement-display';

/**
 * The Keys view (specs/011-redis-capture FR-022, mock section 3): one row per key pattern, slowest first - commands,
 * reads, writes, hit/miss bars, time, failures and who last wrote it; the header says hits, misses and the hit rate.
 */
@Component({
  standalone: true,
  selector: 'app-store-keys',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows(); as list) {
      <div class="rd-bar"><span>One row per key pattern, slowest first ·</span>
        <span><b>{{ hits() }}</b> hits · <b>{{ misses() }}</b> misses@if (hitRate() != null) { · hit rate <b>{{ hitRate() }}%</b> of reads}</span></div>
      <table class="rd-keys">
        <thead><tr><th>Key pattern</th><th style="text-align:right">Commands</th><th style="text-align:right">Reads</th><th style="text-align:right">Writes</th>
          <th>Hit / miss</th><th style="text-align:right">Time</th><th>Last written by</th></tr></thead>
        <tbody>
          @for (r of list; track r.pattern) {
            <tr>
              <td class="k">{{ r.pattern }}@if (r.failed) { <span style="color:var(--red)">✖ {{ r.failed }} failed</span>}</td>
              <td class="n">{{ r.commands }}</td><td class="n">{{ r.reads }}</td><td class="n">{{ r.writes }}</td>
              <td>@if (r.hits + r.misses) {<span class="bar" [style.width.px]="bar(r.hits)"></span><span class="bar m" [style.width.px]="bar(r.misses)" style="margin-left:2px"></span>
                <span style="font-size:.68rem;color:var(--text-faint)"> {{ r.hits }}/{{ r.misses }}</span>} @else {<span style="color:var(--text-faint)">-</span>}</td>
              <td class="n">{{ ms(r.micros) }}</td>
              <td class="lw">{{ r.lastWriter ?? '-' }}</td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <div class="empty">Loading…</div>
    }
  `,
})
export class StoreKeysComponent {
  readonly rows = input<readonly KeyPatternRow[] | null>(null);
  readonly hits = computed(() => (this.rows() ?? []).reduce((n, r) => n + r.hits, 0));
  readonly misses = computed(() => (this.rows() ?? []).reduce((n, r) => n + r.misses, 0));
  readonly hitRate = computed(() => (this.hits() + this.misses() ? Math.round((100 * this.hits()) / (this.hits() + this.misses())) : null));

  protected bar(n: number): number {
    return Math.min(160, n * 9);
  }

  protected ms(micros: number): string {
    return msText(micros);
  }
}
