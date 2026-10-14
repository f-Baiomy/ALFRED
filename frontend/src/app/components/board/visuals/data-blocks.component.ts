import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MentionRef } from '../../../core/models/board.models';
import { LinkedLogLine } from '../../../core/models/call-logs.model';
import { CallDetail } from '../../../core/models/call.model';
import { CapturedStatement, RowsPage } from '../../../core/models/db-capture.model';
import { CallLogsApiService } from '../../../core/services/call-logs-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { SnippetDataService } from '../../../core/services/snippet-data.service';
import { detectBodyKind } from '../../../shared/utils/body-format';
import { diffLines } from '../../../shared/utils/interception-diff';
import { callOf } from '../../../shared/utils/mention-syntax';
import { callRefsIn, queryFields } from '../../../shared/utils/query-blocks';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : (e as { error?: { message?: string } })?.error?.message ?? fallback;
}

function callMention(ref: string): MentionRef {
  return { type: 'call', ref, label: ref } as MentionRef;
}

/**
 * ```statement``` (specs/017 R18): one recorded statement and the rows it read - `call: in:<id>` with `seq: <n>` (its place
 * in the call), or `id: <statement id>`; `rows: 50` how many rows to show.
 */
@Component({
  selector: 'app-statement-block',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="board-vis board-query" dir="ltr">
      <div class="board-vis-bar"><span>◆ statement{{ st() ? ' #' + st()!.seq + ' · ' + st()!.kind : '' }}</span>
        @if (call(); as c) { <app-mention-chip [mention]="c" /> }</div>
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      @if (st(); as s) {
        <pre class="board-vis-src board-query-sql">{{ s.sql }}</pre>
        <div class="board-query-sum">{{ (s.durationMicros / 1000).toFixed(1) }} ms · {{ s.outcome.kind }}{{ s.table ? ' · ' + s.table : '' }}
          @if (s.undone) { · <span class="c-amber">rolled back</span> }</div>
        @if (rows(); as r) {
          @if (r.columns.length) {
            <div class="board-md-table-wrap scroll"><table class="board-md-table">
              <thead><tr>@for (c of r.columns; track $index) { <th>{{ c.name }}</th> }</tr></thead>
              <tbody>@for (row of r.rows; track $index) { <tr>@for (v of row; track $index) { <td>{{ v.value ?? 'NULL' }}</td> }</tr> }</tbody>
            </table></div>
            <div class="board-dim board-query-sum">{{ r.rows.length }} of {{ r.total }} row{{ r.total === 1 ? '' : 's' }} kept</div>
          }
        }
      } @else if (!error()) { <div class="board-dim board-query-empty">Reading the statement…</div> }
    </div>`,
})
export class StatementBlockComponent implements OnInit {
  readonly source = input.required<string>();
  private readonly db = inject(DbCaptureApiService);
  readonly st = signal<CapturedStatement | null>(null);
  readonly rows = signal<RowsPage | null>(null);
  readonly error = signal<string | null>(null);
  readonly call = computed(() => { const r = callRefsIn(this.source())[0]; return r ? callMention(r) : null; });

  async ngOnInit(): Promise<void> {
    const f = queryFields(this.source());
    try {
      let st: CapturedStatement | null = null;
      if (f['id']) {
        st = await firstValueFrom(this.db.statement(Number(f['id'])));
      } else {
        const ref = callRefsIn(this.source())[0];
        const c = ref ? callOf(callMention(ref)) : null;
        if (!c) throw new Error('Name the statement: call: in:<id> with seq: <n>, or id: <statement id>');
        const page = await firstValueFrom(this.db.statements(c.id, 0, 5000));
        const seq = Number(f['seq']);
        st = page.statements.find((s) => s.seq === seq) ?? (f['seq'] ? null : page.statements[0] ?? null);
        if (!st) throw new Error(f['seq'] ? `The call has no statement #${seq}` : 'The call ran no recorded statement');
      }
      this.st.set(st);
      if (st.storedRows > 0) this.rows.set(await firstValueFrom(this.db.rows(st.id, 'RESULT', 0, Math.min(500, Number(f['rows']) || 50))));
    } catch (e) {
      this.error.set(message(e, 'Could not read the statement'));
    }
  }
}

/** ```call-logs``` (specs/017 R18): the log lines a call wrote - `call: in:<id>`, optional `level: WARN` (and worse), `grep: text`. */
@Component({
  selector: 'app-call-logs-block',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="board-vis board-query" dir="ltr">
      <div class="board-vis-bar"><span>▤ log lines{{ lines() ? ' · ' + shown().length + ' of ' + lines()!.length : '' }}</span>
        @if (call(); as c) { <app-mention-chip [mention]="c" /> }</div>
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      @if (lines()) {
        <div class="board-query-logs">
          @for (l of shown(); track l.lineId) {
            <div [class]="'board-query-log ' + (l.level ?? '').toLowerCase()"><span class="board-dim">+{{ l.offsetMs }} ms</span> <b>{{ l.level }}</b> {{ l.message }}</div>
          } @empty { <div class="board-dim">No lines match.</div> }
        </div>
      } @else if (!error()) { <div class="board-dim board-query-empty">Reading the lines…</div> }
    </div>`,
})
export class CallLogsBlockComponent implements OnInit {
  readonly source = input.required<string>();
  private readonly logs = inject(CallLogsApiService);
  readonly lines = signal<readonly LinkedLogLine[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly call = computed(() => { const r = callRefsIn(this.source())[0]; return r ? callMention(r) : null; });
  private static readonly LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  readonly shown = computed(() => {
    const f = queryFields(this.source());
    const min = CallLogsBlockComponent.LEVELS.indexOf((f['level'] ?? '').toUpperCase());
    const grep = (f['grep'] ?? '').toLowerCase();
    return (this.lines() ?? []).filter((l) => (min < 0 || CallLogsBlockComponent.LEVELS.indexOf((l.level ?? '').toUpperCase()) >= min)
      && (!grep || l.message.toLowerCase().includes(grep)));
  });

  async ngOnInit(): Promise<void> {
    const ref = callRefsIn(this.source())[0];
    const c = ref ? callOf(callMention(ref)) : null;
    if (!c) { this.error.set('Name the call: call: in:<id>'); return; }
    try {
      this.lines.set(await firstValueFrom(this.logs.allLines(c.id, c.cycleId)));
    } catch (e) {
      this.error.set(message(e, 'Could not read the lines'));
    }
  }
}

interface Side {
  readonly ref: string;
  readonly detail: CallDetail | null;
  readonly statements: number | null;
  readonly failed: number | null;
  readonly dbMs: number | null;
  readonly errors: number | null;
}

/**
 * ```compare``` (specs/017 R19): two calls side by side from live data - status, time, database work, log errors - and
 * what differs in their headers and response bodies.
 */
@Component({
  selector: 'app-compare-block',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="board-vis board-query" dir="ltr">
      <div class="board-vis-bar"><span>⇆ compare</span></div>
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      @if (sides(); as s) {
        <div class="board-md-table-wrap scroll"><table class="board-md-table board-compare">
          <thead><tr><th></th><th><app-mention-chip [mention]="mention(s[0].ref)" /></th><th><app-mention-chip [mention]="mention(s[1].ref)" /></th></tr></thead>
          <tbody>
            @for (row of facts(); track row.label) {
              <tr [class.diff]="row.a !== row.b"><td>{{ row.label }}</td><td>{{ row.a }}</td><td>{{ row.b }}</td></tr>
            }
          </tbody>
        </table></div>
        @for (part of diffs(); track part.label) {
          <details class="board-callview-part" [open]="part.changed && part.label.startsWith('Response body')">
            <summary>{{ part.label }} {{ part.changed ? '· differs' : '· same' }}</summary>
            <pre class="snip-diff">@for (l of part.lines; track $index) {<span [class]="'snip-diff-' + l.kind">{{ l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  ' }}{{ l.text }}</span>
}</pre></details>
        }
      } @else if (!error()) { <div class="board-dim board-query-empty">Reading both calls…</div> }
    </div>`,
})
export class CompareBlockComponent implements OnInit {
  readonly source = input.required<string>();
  private readonly data = inject(SnippetDataService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  readonly sides = signal<readonly [Side, Side] | null>(null);
  readonly error = signal<string | null>(null);

  readonly facts = computed(() => {
    const s = this.sides();
    if (!s) return [];
    const v = (x: unknown) => (x === null || x === undefined ? '–' : String(x));
    return [
      { label: 'Status', a: v(s[0].detail?.response?.status), b: v(s[1].detail?.response?.status) },
      { label: 'SQL statements', a: v(s[0].statements), b: v(s[1].statements) },
      { label: 'Failed SQL', a: v(s[0].failed), b: v(s[1].failed) },
      { label: 'ms in database', a: v(s[0].dbMs), b: v(s[1].dbMs) },
      { label: 'ERROR log lines', a: v(s[0].errors), b: v(s[1].errors) },
      { label: 'Response size', a: v(s[0].detail?.response?.body?.length), b: v(s[1].detail?.response?.body?.length) },
    ];
  });

  readonly diffs = computed(() => {
    const s = this.sides();
    if (!s) return [];
    const h = (x?: Readonly<Record<string, string>>) => Object.entries(x ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join('\n');
    const parts = [
      { label: 'Request headers', a: h(s[0].detail?.request?.headers), b: h(s[1].detail?.request?.headers) },
      { label: 'Request body', a: s[0].detail?.request?.body ?? '', b: s[1].detail?.request?.body ?? '' },
      { label: 'Response headers', a: h(s[0].detail?.response?.headers), b: h(s[1].detail?.response?.headers) },
      { label: 'Response body', a: s[0].detail?.response?.body ?? '', b: s[1].detail?.response?.body ?? '' },
    ];
    return parts.map((p) => {
      const kind = detectBodyKind(p.a) === detectBodyKind(p.b) ? detectBodyKind(p.a) : 'text';
      const lines = diffLines(p.a, p.b, kind, false);
      return { label: p.label, changed: lines.some((l) => l.kind !== 'same'), lines };
    });
  });

  async ngOnInit(): Promise<void> {
    const refs = callRefsIn(this.source());
    if (refs.length < 2) { this.error.set('Name two calls: one mention per line'); return; }
    try {
      const sides = await Promise.all(refs.slice(0, 2).map((r) => this.side(r)));
      this.sides.set([sides[0], sides[1]]);
    } catch (e) {
      this.error.set(message(e, 'Could not read the calls'));
    }
  }

  mention(ref: string): MentionRef {
    return callMention(ref);
  }

  private async side(ref: string): Promise<Side> {
    const c = callOf(callMention(ref));
    if (!c) throw new Error(`"${ref}" is not a call`);
    const detail = await this.data.read('call', { ref }).catch(() => null) as CallDetail | null;
    if (c.direction !== 'in') return { ref, detail, statements: null, failed: null, dbMs: null, errors: null };
    const [db, logs] = await Promise.all([
      firstValueFrom(this.db.summaries([c.id])).catch(() => ({})),
      firstValueFrom(this.logs.counts([c.id], c.cycleId)).catch(() => ({})),
    ]);
    const s = (db as Record<string, { statementCount: number; failedCount: number; dbMicros: number }>)[c.id];
    const l = (logs as Record<string, { errors: number }>)[c.id];
    return { ref, detail, statements: s ? s.statementCount : null, failed: s ? s.failedCount : null, dbMs: s ? Math.round(s.dbMicros / 1000) : null,
      errors: l ? l.errors : null };
  }
}
