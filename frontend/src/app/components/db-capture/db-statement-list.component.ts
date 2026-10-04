import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { DbGroupNode, DbNode, DbSupplierNode, statementsOf } from '../../shared/utils/db-statement-tree';
import { isWrite, msText, resultText, verbClass, verbOf } from '../../shared/utils/db-statement-display';
import { DbSqlComponent } from './db-sql.component';
import { DbStatementDetailComponent } from './db-statement-detail.component';
import { DbWindowState } from './db-window-state';

/**
 * The window's statement tree (mock: ".r" rows, ".g" groups with branch lines, ".sup" supplier markers between
 * statements). Recursive: a group renders its children with another of these. Filters (search, kind, table) hide
 * rows; a group with nothing left visible disappears, as do supplier markers while any filter is on.
 */
@Component({
  standalone: true,
  selector: 'app-db-statement-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbSqlComponent, DbStatementDetailComponent],
  template: `
    @for (node of nodes(); track node.type + node.seq) {
      @switch (node.type) {
        @case ('stmt') {
          @let s = $any(node).statement;
          @if (state.matches(s)) {
            <div class="r" [class.open]="isOpen(s)" [class.fail]="s.outcome.kind === 'FAILED' || noWhere(s)" [class.undone]="s.undone"
                 [class.flash]="state.flashSeq() === s.seq" [attr.data-seq]="s.seq">
              <div class="rh" (click)="state.toggleOpen(s.seq)">
                <span class="chev">▶</span>
                <span class="num">#{{ s.seq }}</span>
                <span class="verb" [class]="verbClass(s)">{{ verbOf(s) }}</span>
                <span class="sql1">@if (s.params.length > 1) {<span class="mark bt" [title]="'executeBatch - ' + s.params.length + ' parameter sets in one round trip'">BATCH ×{{ s.params.length }}</span>}<app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" /></span>
                <span class="res">{{ resultText(s) }}</span>
                <span class="ms" [class.mid]="s.durationMicros > 5000">{{ msText(s.durationMicros) }}</span>
                <span class="off">+{{ offset(s.offsetMicros) }} ms</span>
              </div>
              @if (isOpen(s)) {
                <app-db-statement-detail [statement]="s" />
              }
            </div>
          }
        }
        @case ('supplier') {
          @if (!state.filtering() && state.showSuppliers()) {
            @let m = $any(node);
            @let sup = supplier(m);
            <div class="sup" [attr.data-seq]="m.seq" [class.flash]="state.flashSeq() === m.seq">
              <span class="num">#{{ m.seq }}</span>
              <span class="verb sup-verb">{{ m.marker.method ?? sup?.method ?? 'HTTP' }}</span>
              <span class="u">{{ sup?.url ?? m.marker.url }}</span>
              @if (sup) {
                <span class="res" [style.color]="(sup.response?.status ?? 0) >= 400 || sup.error ? 'var(--red)' : 'var(--green)'">{{ sup.error ? 'ERROR' : (sup.response?.status ?? '…') }}</span>
                <span class="ms mid">{{ sup.duration_ms }} ms</span>
                <a (click)="showCall.emit(sup)">show call ↗</a>
              } @else {
                <span class="res dimtxt" title="The outbound call is not on this page (or was not logged)">not loaded</span>
              }
            </div>
          }
        }
        @default {
          @let g = $any(node);
          @if (visibleCount(g) > 0) {
            <div class="g" [class.repeat]="g.type === 'repeat'" [class.rolled]="g.rolledBack" [class.closed]="isFolded(g)">
              <div class="rh" (click)="state.toggleFold(g.key)" [attr.data-group]="g.key">
                <span class="chev">▶</span>
                <span class="num">#{{ g.seq }}</span>
                @if (g.type === 'tx') {
                  <span class="verb" [class]="g.rolledBack ? 'v-fail' : 'v-tx'">TX</span>
                  <span class="lbl">{{ txLabel(g) }} <span class="meta">· {{ stmts(g).length }} statements · {{ writes(g) }} writes · held {{ msText(g.tx.heldMicros) }}</span></span>
                } @else {
                  <span class="verb" [class]="verbClass(stmts(g)[0])">{{ verbOf(stmts(g)[0]) }}</span>
                  <span class="lbl"><app-db-sql [sql]="g.sql" [filled]="false" /> <span class="rep">×{{ stmts(g).length }}</span></span>
                }
                <span class="res">#{{ g.seq }}–#{{ lastSeq(g) }}</span>
                <span class="ms">{{ msText(totalMicros(g)) }}</span>
                <span class="off">+{{ offset(stmts(g)[0].offsetMicros) }} ms</span>
                @if (warning(g); as w) {
                  <span class="g-warn" [style.color]="g.rolledBack ? 'var(--red)' : null">⚠ {{ w }}</span>
                }
              </div>
              <div class="gb">
                <app-db-statement-list [nodes]="g.children" (showCall)="showCall.emit($event)" />
              </div>
            </div>
          }
        }
      }
    }
  `,
})
export class DbStatementListComponent {
  protected readonly state = inject(DbWindowState);
  readonly nodes = input.required<readonly DbNode[]>();
  readonly showCall = output<CallRecord>();

  protected readonly verbOf = verbOf;
  protected readonly verbClass = verbClass;
  protected readonly resultText = resultText;
  protected readonly msText = msText;

  private readonly anyFiltering = computed(() => this.state.filtering());

  isOpen(s: CapturedStatement): boolean {
    return this.state.open().has(s.seq);
  }

  /** Folded unless a filter is on (then matches inside must show). Transactions and repeats start folded. */
  isFolded(g: DbGroupNode): boolean {
    return !this.anyFiltering() && this.state.folded().has(g.key);
  }

  noWhere(s: CapturedStatement): boolean {
    return (s.kind === 'DELETE' || s.kind === 'UPDATE') && !/\bWHERE\b/i.test(s.sql);
  }

  supplier(m: DbSupplierNode): CallRecord | undefined {
    return this.state.suppliersBySeq().get(m.seq);
  }

  stmts(g: DbGroupNode): CapturedStatement[] {
    return statementsOf(g);
  }

  visibleCount(g: DbGroupNode): number {
    return this.stmts(g).filter((s) => this.state.matches(s)).length;
  }

  writes(g: DbGroupNode): number {
    return this.stmts(g).filter(isWrite).length;
  }

  lastSeq(g: DbGroupNode): number {
    const all = this.stmts(g);
    return all[all.length - 1]?.seq ?? g.seq;
  }

  totalMicros(g: DbGroupNode): number {
    return this.stmts(g).reduce((sum, s) => sum + s.durationMicros, 0);
  }

  offset(micros: number): string {
    return (micros / 1000).toFixed(0);
  }

  txLabel(g: DbGroupNode): string {
    const tx = g.tx!;
    const outcome = tx.outcome === 'ROLLED_BACK' ? 'rolled back' : tx.outcome === 'OPEN' ? 'still open' : 'committed';
    return `${tx.txId}${tx.connectionId ? ' · ' + tx.connectionId : ''} · ${outcome}`;
  }

  warning(g: DbGroupNode): string | null {
    if (g.type === 'repeat') {
      const n = this.stmts(g).length;
      const sameParams = new Set(this.stmts(g).map((s) => JSON.stringify(s.params))).size === 1;
      return sameParams ? `same query ${n}× with the same params - could be cached` : `same query ${n}× with different params - looks like N+1`;
    }
    if (g.rolledBack) return 'rolled back - nothing in this transaction was saved or deleted';
    if (g.children.some((c) => c.type === 'supplier') && this.stmts(g).some((s) => /\bFOR\s+UPDATE\b/i.test(s.sql) || isWrite(s))) {
      return 'a supplier call ran while this transaction held row locks';
    }
    if (g.tx?.outcome === 'OPEN') return 'never committed or rolled back while the call ran';
    return null;
  }
}
