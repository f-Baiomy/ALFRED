import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CapturedStatement, TypedValue } from '../../core/models/db-capture.model';
import { codeFileLine, isBatch, isDelete, isFailed, isTxEnd, rowCountOf, valueText } from '../../shared/utils/db-statement-display';
import { blobLabel, isBinary, isOutParam, sqlText } from '../../shared/utils/sql-render';
import { DbHideColumnComponent } from './db-hide-column.component';
import { DbRowsTableComponent } from './db-rows-table.component';
import { paramColumns } from '../../shared/utils/sql-param-columns';
import { DbSqlComponent } from './db-sql.component';
import { DbDetailTab, DbWindowState } from './db-window-state';

interface TabDef {
  readonly key: DbDetailTab;
  readonly label: string;
}

/**
 * An expanded statement (mock: ".rd"). The tab list is built from one array so later tabs - Relive's "In Relive" -
 * slot in without touching the others.
 */
@Component({
  standalone: true,
  selector: 'app-db-statement-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbSqlComponent, DbRowsTableComponent, DbHideColumnComponent],
  template: `
    <div class="rd">
      <div class="tabs2">
        @for (t of tabs(); track t.key) {
          <button type="button" class="tab2" [class.on]="t.key === current()" (click)="state.setTab(statement().seq, t.key)">{{ t.label }}</button>
        }
        <span class="sp"></span>
        <button type="button" class="action-btn" (click)="copySql()">{{ copied() ? 'Copied' : 'Copy SQL' }}</button>
      </div>
      @switch (current()) {
        @case ('error') {
          <div class="errbox">
            <div><b style="color:var(--red)">{{ statement().outcome.message }}</b></div>
            <div>SQLState <code>{{ statement().outcome.sqlState ?? '-' }}</code> · vendor code <code>{{ statement().outcome.vendorCode ?? '-' }}</code></div>
            @for (c of statement().outcome.chain ?? []; track $index) {
              <div style="color:var(--text-dim)">caused by {{ c }}</div>
            }
            @if (statement().outcome.swallowed) {
              <div style="color:var(--amber)">⚠ The application caught this - the call still answered without an error, so nobody saw it.</div>
            }
            @if (statement().undone) {
              <div style="color:var(--text-dim)">Its transaction was rolled back - see the struck-through statements.</div>
            }
          </div>
        }
        @case ('deleted') {
          @if (statement().undone) {
            <div class="errbox" style="margin-bottom:.45rem"><b style="color:var(--red)">Rolled back - nothing was deleted.</b> These are the rows it would have removed.</div>
          }
          @for (child of statement().cascadesTo ?? []; track child) {
            <div class="warnbox">⚠ <code>{{ statement().table }}</code> has <code>ON DELETE CASCADE</code> → <code>{{ child }}</code>. The database removed the child rows on its own; JDBC never reports them, so the agent can't see them.</div>
          }
          @switch (statement().beforeImage?.source) {
            @case ('EARLIER_READ') {
              <div class="dimline">{{ rowCount() }} rows deleted - contents taken from <span class="lnk">#{{ statement().beforeImage?.earlierSeq }}</span>, which read the same rows earlier in this call. Could differ if something changed them in between.</div>
              <app-db-rows-table [statementId]="statement().id" part="BEFORE_IMAGE" />
            }
            @case ('AGENT_READ') {
              <div class="dimline">Captured by the agent just before the {{ statement().kind }} (before-image on for <code>{{ statement().table }}</code> · extra read {{ extraReadMs() }} ms, same transaction).</div>
              <app-db-rows-table [statementId]="statement().id" part="BEFORE_IMAGE" />
            }
            @default {
              <div class="empty-cap"><b>{{ rowCount() }} rows deleted - contents not captured.</b> JDBC only reports how many rows a DELETE removed, and Alfred never reads your database by itself.
                @if (statement().beforeImage?.skippedReason; as why) { <br>{{ why }} }</div>
              <div class="infobox"><span>Turn on <b>before-image</b> for <code>{{ statement().table }}</code> (Settings → Database capture) to capture them: the agent reads the affected rows just before each DELETE - one extra read on your database, in the same transaction. Off by default.</span></div>
            }
          }
        }
        @case ('sql') {
          <div class="sqlb"><app-db-sql [sql]="statement().sql" [params]="statement().params[0]" [filled]="state.fill()" [pretty]="true" /></div>
          @if (batch()) {
            <div class="dimline">Sent once with executeBatch - {{ statement().params.length }} parameter sets. Shown with set 1; see Params for all.</div>
          }
        }
        @case ('params') {
          @if (batch()) {
            <table class="kvt">
              <tr><th>Set</th>@for (p of statement().params[0]; track $index) {<th>?{{ $index + 1 }} {{ p.type }}</th>}</tr>
              @for (set of statement().params; track $index) {
                <tr><td class="dim">{{ $index + 1 }}</td>
                  @for (v of set; track $index) {<td [class.hit]="isHit(v)" (click)="state.toggleTrace(v.value)">{{ show(v) }}</td>}
                </tr>
              }
            </table>
          } @else {
            <table class="kvt">
              <tr><th>#</th><th>JDBC type</th><th>Value</th><th>Column</th></tr>
              @for (v of firstSet(); track $index) {
                <tr><td>{{ $index + 1 }}</td><td class="dim">{{ v.type }}</td>
                  <td [class.hit]="isHit(v)" (click)="state.toggleTrace(v.value)">
                    @if (binary(v)) {<span class="blob">{{ blob(v) }}</span> <a class="lnk" (click)="download(v)">Open ↗</a>}
                    @else if (out(v)) {{{ show(v) }} <span class="dimtxt">returned (OUT)</span>}
                    @else {{{ show(v) }}}
                    @if (v.truncatedAt != null) { <span class="dimtxt">· kept the first {{ v.truncatedAt.toLocaleString() }} bytes</span> }
                  </td>
                  <td class="dim">@if (paramColumns()[$index]; as col) {{{ col }} <app-db-hide-column [column]="col" />}</td></tr>
              }
            </table>
          }
        }
        @case ('rows') {
          <app-db-rows-table [statementId]="statement().id" part="RESULT" />
        }
        @case ('keys') {
          <table class="kvt">
            @for (row of statement().outcome.generatedKeys ?? []; track $index) {
              <tr>@for (v of row; track $index) {<td [class.hit]="isHit(v)" (click)="state.toggleTrace(v.value)">{{ show(v) }}</td>}</tr>
            }
          </table>
        }
        @case ('where') {
          <table class="kvt">
            <tr><th>Thread</th><td>{{ statement().thread }}</td></tr>
            <tr><th>Called from</th><td>{{ statement().codeLocation ?? 'not known' }}</td></tr>
            @if (statement().connectionId) {<tr><th>Connection</th><td>{{ statement().connectionId }}{{ statement().dataSource ? ' · ' + statement().dataSource : '' }}</td></tr>}
            @if (fileLine(); as fl) {
              <tr><th>Open</th><td class="ide"><a [href]="'idea://open?file=' + fl.file + '&line=' + fl.line">IntelliJ ↗</a><a [href]="'vscode://file/' + fl.file + ':' + fl.line">VS Code ↗</a></td></tr>
            }
          </table>
        }
      }
    </div>
  `,
})
export class DbStatementDetailComponent {
  protected readonly state = inject(DbWindowState);
  readonly statement = input.required<CapturedStatement>();
  protected readonly copied = signal(false);

  readonly batch = computed(() => isBatch(this.statement()));
  readonly firstSet = computed<readonly TypedValue[]>(() => this.statement().params[0] ?? []);
  readonly rowCount = computed(() => rowCountOf(this.statement()).toLocaleString());
  /** The column each parameter is bound to, where the SQL says (INSERT list, SET/WHERE col = ?). */
  readonly paramColumns = computed(() => paramColumns(this.statement().sql));
  readonly fileLine = computed(() => codeFileLine(this.statement().codeLocation));
  readonly extraReadMs = computed(() => ((this.statement().beforeImage?.extraReadMicros ?? 0) / 1000).toFixed(1));

  readonly tabs = computed<TabDef[]>(() => {
    const s = this.statement();
    const tabs: TabDef[] = [];
    if (isFailed(s)) tabs.push({ key: 'error', label: 'Error' });
    if (isDelete(s) && !isFailed(s)) {
      const known = s.beforeImage && s.beforeImage.source !== 'NONE';
      tabs.push({ key: 'deleted', label: `Deleted rows${known ? ` (${rowCountOf(s).toLocaleString()})` : ''}` });
    }
    tabs.push({ key: 'sql', label: 'Statement' });
    const params = s.params[0]?.length ?? 0;
    if (params) tabs.push({ key: 'params', label: isBatch(s) ? `Params (${s.params.length} sets)` : `Params (${params})` });
    if ((s.outcome.kind === 'ROWS' || s.outcome.kind === 'PROCEDURE') && (s.storedRows > 0 || (s.outcome.rowsRead ?? 0) > 0)) {
      tabs.push({ key: 'rows', label: `Rows (${(s.outcome.rowsRead ?? s.storedRows).toLocaleString()})` });
    }
    if (s.outcome.generatedKeys?.length) tabs.push({ key: 'keys', label: 'Generated keys' });
    if (!isTxEnd(s)) tabs.push({ key: 'where', label: 'Where in code' });
    return tabs;
  });

  readonly current = computed<DbDetailTab>(() => {
    const chosen = this.state.tabs().get(this.statement().seq);
    const tabs = this.tabs();
    return tabs.some((t) => t.key === chosen) ? (chosen as DbDetailTab) : tabs[0].key;
  });

  show(v: TypedValue): string {
    return valueText(v);
  }

  binary(v: TypedValue): boolean {
    return isBinary(v);
  }

  out(v: TypedValue): boolean {
    return isOutParam(v);
  }

  blob(v: TypedValue): string {
    return blobLabel(v);
  }

  isHit(v: TypedValue): boolean {
    return v.value != null && v.value === this.state.trace();
  }

  /** A binary parameter is stored base64; "Open" saves it as a file. */
  download(v: TypedValue): void {
    if (v.value == null) return;
    const bin = atob(v.value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `statement-${this.statement().seq}-param.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  copySql(): void {
    const s = this.statement();
    const text = s.params.length > 1
      ? s.params.map((set) => sqlText(s.sql, set, this.state.fill())).join(';\n') + ';'
      : sqlText(s.sql, s.params[0], this.state.fill());
    void navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1200);
    });
  }
}
