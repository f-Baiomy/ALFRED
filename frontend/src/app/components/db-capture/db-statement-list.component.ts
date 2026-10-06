import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement, StatementOrigin } from '../../core/models/db-capture.model';
import { DbGroupNode, DbNode, DbSupplierNode, logsOf, statementsOf } from '../../shared/utils/db-statement-tree';
import { DbLogRowComponent } from './db-log-row.component';
import { isWrite, msText, resultText, verbClass, verbOf } from '../../shared/utils/db-statement-display';
import { DbSqlComponent } from './db-sql.component';
import { DbQueryTextComponent } from './db-query-text.component';
import { OriginBadge, originBadge, originSummary } from '../../shared/utils/db-origin';
import { DbStatementDetailComponent } from './db-statement-detail.component';
import { DbWindowState } from './db-window-state';

/**
 * The window's statement tree (mock: ".r" rows, ".g" groups with branch lines, ".sup" supplier markers between
 * statements). Recursive: a group renders its children with another of these. Filters (search, kind, table) hide
 * rows; a group with nothing left visible disappears, as do supplier markers while any filter is on.
 */
/**
 * A query whose text the agent could not read (an older agent on an app with two copies of Hibernate lost it): a bare
 * "query" would hide what ran, so its row shows the SQL even in "Show rows as HQL".
 */
function textless(o: StatementOrigin): boolean {
  return (o.kind === 'HQL' || o.kind === 'NATIVE' || o.kind === 'CRITERIA') && !o.text && !o.name;
}

@Component({
  standalone: true,
  selector: 'app-db-statement-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbSqlComponent, DbQueryTextComponent, DbStatementDetailComponent, DbLogRowComponent],
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
                <span class="sql1">@if (badge(s); as b) {<span class="orig" [class]="b.cls" [title]="b.title">{{ b.label }}</span>}@if (s.params.length > 1) {<span class="mark bt" [title]="'executeBatch - ' + s.params.length + ' parameter sets in one round trip'">BATCH ×{{ s.params.length }}</span>}@if (asOrigin(s)) {@if (s.origin.text) {<span class="hqltext"><app-db-query-text [text]="s.origin.text" [oneLine]="true" /></span>} @else {<span class="dimtxt">{{ summary(s.origin) }}</span>}} @else {<app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" />}</span>
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
        @case ('log') {
          @let lg = $any(node);
          @if (state.matchesLog(lg.line)) {
            <app-db-log-row class="tlog" [line]="lg.line" [atMs]="lg.line.offsetMs" [class.flash]="state.flashSeq() === lg.seq" />
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
            <div class="g" [class.repeat]="g.type === 'repeat'" [class.query]="g.type === 'query'" [class.rolled]="g.rolledBack" [class.closed]="isFolded(g)">
              <div class="rh" (click)="state.toggleFold(g.key)" [attr.data-group]="g.key">
                <span class="chev">▶</span>
                <span class="num">#{{ g.seq }}</span>
                @if (g.type === 'tx') {
                  <span class="verb" [class]="g.rolledBack ? 'v-fail' : 'v-tx'">TX</span>
                  <span class="lbl">{{ txLabel(g) }} <span class="meta">· {{ stmts(g).length }} statements · {{ writes(g) }} writes · held {{ msText(g.tx.heldMicros) }}</span></span>
                } @else if (g.type === 'query') {
                  <span class="verb v-hql">{{ queryLabel(g) }} ×{{ stmts(g).length }}</span>
                  <span class="lbl">@if (g.origin?.text) {<app-db-query-text [text]="g.origin.text" [oneLine]="true" />} @else {{{ groupSummary(g) }}} <span class="meta">· 1 query → {{ stmts(g).length }} SQL statements</span></span>
                } @else {
                  <span class="verb" [class]="verbClass(stmts(g)[0])">{{ verbOf(stmts(g)[0]) }}</span>
                  <span class="lbl"><app-db-sql [sql]="g.sql" [filled]="false" /> <span class="rep">×{{ stmts(g).length }}</span></span>
                }
                <span class="res">#{{ g.seq }}–#{{ lastSeq(g) }}</span>
                <span class="ms">{{ msText(totalMicros(g)) }}</span>
                <span class="off">@if (stmts(g)[0]; as first) {+{{ offset(first.offsetMicros) }} ms}</span>
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

  badge(s: CapturedStatement): OriginBadge | null {
    return originBadge(s, this.state.hasOrigins());
  }

  /** "Show rows as HQL": the row shows what the code wrote (or what Hibernate did) instead of the SQL. */
  asOrigin(s: CapturedStatement): boolean {
    return this.state.rowsAs() === 'hql' && !!s.origin && s.origin.kind !== 'HIBERNATE' && !textless(s.origin);
  }

  summary(o: StatementOrigin): string {
    return originSummary(o);
  }

  groupSummary(g: DbGroupNode): string {
    return g.origin && !textless(g.origin) ? originSummary(g.origin) : 'query text not recorded - the SQL it ran is below';
  }

  queryLabel(g: DbGroupNode): string {
    const kind = g.origin?.kind;
    return kind === 'NATIVE' ? 'NATIVE' : kind === 'CRITERIA' ? 'CRITERIA' : kind === 'HQL' ? 'HQL' : 'QUERY';
  }

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
    return this.stmts(g).filter((s) => this.state.matches(s)).length + logsOf(g).filter((l) => this.state.matchesLog(l)).length;
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
    const l = tx.lifecycle;
    const ms = (us?: number | null) => (us == null ? null : us >= 10_000 ? `${Math.round(us / 1000)} ms` : `${(us / 1000).toFixed(1)} ms`);
    const parts = l ? [ms(l.acquireMicros) && `checkout ${ms(l.acquireMicros)}`, ms(l.beginMicros) && `begin ${ms(l.beginMicros)}`,
      ms(l.commitMicros) && `${tx.outcome === 'ROLLED_BACK' ? 'rollback' : 'commit'} ${ms(l.commitMicros)}`, ms(l.closeMicros) && `close ${ms(l.closeMicros)}`].filter(Boolean) : [];
    return `${tx.txId}${tx.connectionId ? ' · ' + tx.connectionId : ''} · ${outcome}${l?.via ? ` (${l.via})` : ''}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
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
