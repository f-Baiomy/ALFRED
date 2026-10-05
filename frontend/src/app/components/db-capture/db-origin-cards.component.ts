import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { isQueryOrigin, nativeComparison, originExplanation, pagingText, translationLine } from '../../shared/utils/db-origin';
import { DbQueryTextComponent } from './db-query-text.component';
import { DbSqlComponent } from './db-sql.component';
import { DbWindowState } from './db-window-state';

/**
 * The Statement tab when Hibernate is in the picture (mock: specs/006-db-capture/hql-mock.html, parts 2 and 2b) - what
 * the code wrote on top, what the database received below, a line between saying what changed. A statement with no
 * origin in a call without any ORM keeps the plain SQL block (the detail renders that itself).
 */
@Component({
  standalone: true,
  selector: 'app-db-origin-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbQueryTextComponent, DbSqlComponent],
  template: `
    @let s = statement();
    @let o = s.origin;
    <div class="oc-pair">
      @if (o && query()) {
        @if (o.kind === 'NATIVE' && comparison() !== 'changed') {
          <!-- native SQL sent as written (only :name → ? changed): one card -->
          <div class="oc-card nat">
            <div class="oc-hd"><b>SQL in your code - sent as written</b>
              <span>native query{{ o.name ? ' ' : '' }}@if (o.name) {<code>{{ o.name }}</code>} · {{ comparison() === 'params' ? 'only the named parameters became ?' : 'nothing changed' }}</span>
              <span class="r2"><button type="button" class="action-btn" (click)="copy(o.text ?? '')">{{ copied() ? 'Copied' : 'Copy' }}</button></span></div>
            <pre class="oc-pre"><app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" [pretty]="true" /></pre>
            @if (o.params?.length) {
              <table class="kvt oc-params"><tr><th>Parameter</th><th>Value</th></tr>
                @for (p of o.params; track $index) {<tr><td class="np">{{ p.name }}</td><td>{{ p.value ?? 'null' }}</td></tr>}</table>
            }
            <div class="oc-ft">Run at <code>{{ s.codeLocation ?? 'unknown' }}</code>@if (o.method) { · <code>query.{{ o.method }}()</code>}</div>
          </div>
        } @else {
          <div class="oc-card" [class.hql]="o.kind !== 'NATIVE'" [class.nat]="o.kind === 'NATIVE'">
            <div class="oc-hd">
              <b>1 · {{ o.kind === 'NATIVE' ? 'SQL in your code' : o.kind === 'CRITERIA' ? 'Criteria - the query in your code' : 'HQL - the query in your code' }}</b>
              @if (o.name) {<span>named query <code>{{ o.name }}</code></span>}
              @else if (o.kind === 'NATIVE') {<span>native query (<code>createNativeQuery</code>) · not HQL</span>}
              <span class="r2"><button type="button" class="action-btn" (click)="copy(o.text ?? '')">{{ copied() ? 'Copied' : o.kind === 'NATIVE' ? 'Copy' : 'Copy HQL' }}</button></span>
            </div>
            <pre class="oc-pre q"><app-db-query-text [text]="o.text ?? ''" /></pre>
            @if (o.params?.length || paging()) {
              <table class="kvt oc-params"><tr><th>Parameter</th><th>Value</th></tr>
                @for (p of o.params ?? []; track $index) {<tr><td class="np">{{ p.name }}</td><td>{{ p.value ?? 'null' }}</td></tr>}
                @if (paging(); as pg) {<tr><td class="dim">page</td><td>{{ pg }} <span class="dimtxt">- added to the SQL by Hibernate</span></td></tr>}
              </table>
            }
            <div class="oc-ft">Run at <code>{{ s.codeLocation ?? 'unknown' }}</code>@if (o.method) { · <code>query.{{ o.method }}()</code>}</div>
          </div>
          <div class="oc-arrow">↓ {{ translation() }}@if (o.kind !== 'NATIVE') { <span class="dimtxt">(this is #{{ s.seq }}{{ sqlCount() > 1 ? ', ' + positionText() : '' }})</span>}</div>
          <div class="oc-card">
            <div class="oc-hd"><b>2 · SQL - what was sent to the database</b>
              <span>{{ state.fill() ? 'values filled in' : 'placeholders kept' }}@if (o.kind === 'NATIVE') { · <span class="oc-diff">differs from the code</span>}</span></div>
            <pre class="oc-pre"><app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" [pretty]="true" /></pre>
          </div>
        }
      } @else if (o) {
        <div class="oc-info">{{ explanation() }}@if (s.codeLocation) { Triggered at <code>{{ s.codeLocation }}</code>.}</div>
        <div class="oc-card">
          <div class="oc-hd"><b>SQL - what Hibernate sent</b><span>{{ state.fill() ? 'values filled in' : 'placeholders kept' }}</span></div>
          <pre class="oc-pre"><app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" [pretty]="true" /></pre>
        </div>
      } @else {
        <div class="oc-card">
          <div class="oc-hd"><b>SQL - written in your code and sent as written</b>
            <span>plain JDBC - no Hibernate in between, so there is nothing to translate</span></div>
          <pre class="oc-pre"><app-db-sql [sql]="s.sql" [params]="s.params[0]" [filled]="state.fill()" [pretty]="true" /></pre>
          @if (s.codeLocation) {<div class="oc-ft">Run at <code>{{ s.codeLocation }}</code></div>}
        </div>
      }
    </div>
  `,
})
export class DbOriginCardsComponent {
  protected readonly state = inject(DbWindowState);
  readonly statement = input.required<CapturedStatement>();
  protected readonly copied = signal(false);

  readonly query = computed(() => isQueryOrigin(this.statement().origin));
  readonly comparison = computed(() => {
    const s = this.statement();
    return s.origin?.kind === 'NATIVE' ? nativeComparison(s.origin, s.sql) : 'changed';
  });
  readonly paging = computed(() => (this.statement().origin ? pagingText(this.statement().origin!) : null));
  /** The SQL statements the same query execution produced, in order. */
  private readonly siblings = computed(() => {
    const id = this.statement().origin?.id;
    if (!id) return [];
    return [...this.state.statementBySeq().values()].filter((x) => x.origin?.id === id).sort((a, b) => a.seq - b.seq);
  });
  readonly sqlCount = computed(() => Math.max(1, this.siblings().length));
  readonly positionText = computed(() => {
    const seqs = this.siblings().map((x) => '#' + x.seq);
    return `the others: ${seqs.filter((x) => x !== '#' + this.statement().seq).join(', ')}`;
  });
  readonly translation = computed(() => translationLine(this.statement().origin!, this.statement().sql, this.sqlCount()));
  readonly explanation = computed(() => originExplanation(this.statement().origin!));

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1200);
    });
  }
}
