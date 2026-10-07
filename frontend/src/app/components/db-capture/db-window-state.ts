import { StoreCommandSummary } from '../../core/models/store-command.model';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { logLevelClass } from '../../shared/utils/call-log-rows';
import { Injectable, computed, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { isDelete, isFailed, isTxEnd, isWrite, valueText } from '../../shared/utils/db-statement-display';
import { readRowsAs } from '../../shared/utils/db-group-preference';

export type DbKindFilter = 'all' | 'read' | 'write' | 'delete' | 'fail';
/** The Redis view's filter (specs/011-redis-capture mock section 3). */
export type RedisKindFilter = 'all' | 'r' | 'w' | 'miss' | 'fail';
export type DbDetailTab = 'error' | 'deleted' | 'sql' | 'params' | 'rows' | 'keys' | 'before' | 'where';

/**
 * One open database window's view state - shared by the window and the rows, groups and details inside it (provided
 * by DbWindowComponent, so each window has its own). Statement keys are their `seq` within the call.
 */
@Injectable()
export class DbWindowState {
  readonly search = signal('');
  readonly kind = signal<DbKindFilter>('all');
  readonly table = signal('');
  readonly fill = signal(true);
  /** "Show rows as": the query the code wrote (HQL/native) or the SQL that was sent - only matters when the call has origins. */
  readonly rowsAs = signal<'hql' | 'sql'>(readRowsAs());
  /** Some statement of this call came from an ORM - JDBC statements then say so, and the HQL controls show. */
  readonly hasOrigins = signal(false);
  readonly showSuppliers = signal(true);
  /** Together: the call's log lines in the statement list (View menu). */
  readonly showLogs = signal(true);
  readonly open = signal<ReadonlySet<number>>(new Set());
  readonly folded = signal<ReadonlySet<string>>(new Set());
  readonly tabs = signal<ReadonlyMap<number, DbDetailTab>>(new Map());
  /** A value clicked to trace - every cell and parameter equal to it is highlighted. */
  readonly trace = signal('');
  /** The statement just jumped to - flashes once. */
  readonly flashSeq = signal<number | null>(null);
  /** The call's outbound (supplier) calls the page has loaded, by their place in the call's sequence. */
  readonly suppliersBySeq = signal<ReadonlyMap<number, CallRecord>>(new Map());
  /** The call's project - its settings (before-image tables, expected statements) are what the detail changes. */
  readonly project = signal<string | null>(null);
  /** Every loaded statement by its seq - a detail links to an earlier read of the same rows. */
  readonly statementBySeq = signal<ReadonlyMap<number, CapturedStatement>>(new Map());
  /** A detail asking the window to jump (e.g. "contents taken from #3"). */
  readonly jumpRequest = signal<{ readonly seq: number; readonly tab?: DbDetailTab } | null>(null);
  /** The statements a SQL query over `statements` selected (by `n`), or null when no query is applied. */
  readonly statementSeqs = signal<ReadonlySet<number> | null>(null);

  readonly filtering = computed(() => !!this.search() || this.kind() !== 'all' || !!this.table() || this.statementSeqs() != null);

  toggleOpen(seq: number): void {
    const next = new Set(this.open());
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    this.open.set(next);
  }

  toggleFold(key: string): void {
    const next = new Set(this.folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.folded.set(next);
  }

  setTab(seq: number, tab: DbDetailTab): void {
    this.tabs.set(new Map(this.tabs()).set(seq, tab));
  }

  toggleTrace(value: string | null | undefined): void {
    if (value == null) return;
    this.trace.set(this.trace() === value ? '' : value);
  }

  /**
   * A log line under the statement filters (Together): All shows every line, Failed shows ERROR lines, the other kinds
   * (reads, writes, deletes) and a table or query filter hide them; the search looks in message, logger, level, thread.
   */
  matchesLog(line: LinkedLogLine): boolean {
    if (!this.showLogs() || this.statementSeqs() != null || this.table()) return false;
    const kind = this.kind();
    if (kind === 'fail') {
      if (logLevelClass(line.level) !== 'error' && !line.exception) return false;
    } else if (kind !== 'all') {
      return false;
    }
    const q = this.search().toLowerCase();
    if (!q) return true;
    return `${line.message} ${line.logger ?? ''} ${line.level ?? ''} ${line.thread ?? ''} ${line.exception?.type ?? ''} ${line.exception?.message ?? ''}`
      .toLowerCase().includes(q);
  }

  matches(s: CapturedStatement): boolean {
    const selected = this.statementSeqs();
    if (selected && !selected.has(s.seq)) return false;
    switch (this.kind()) {
      case 'read':
        if (isWrite(s) || isTxEnd(s)) return false;
        break;
      case 'write':
        if (!isWrite(s)) return false;
        break;
      case 'delete':
        if (!isDelete(s)) return false;
        break;
      case 'fail':
        if (!(isFailed(s) || s.undone || s.kind === 'ROLLBACK')) return false;
        break;
    }
    const table = this.table();
    if (table && (s.table ?? '').toLowerCase() !== table.toLowerCase()) return false;
    const q = this.search().toLowerCase();
    if (!q) return true;
    const o = s.origin;
    const origin = o ? ` ${o.text ?? ''} ${o.name ?? ''} ${o.entity ?? ''} ${o.role ?? ''} ${(o.params ?? []).map((p) => `${p.name} ${p.value ?? ''}`).join(' ')}` : '';
    const text = `${s.sql} ${s.table ?? ''} ${s.params.flat().map(valueText).join(' ')}${origin}`.toLowerCase();
    return text.includes(q);
  }

  // ---- Redis (specs/011-redis-capture) ----

  /** The call the window shows - the Redis detail searches its bodies when a value is traced. */
  readonly call = signal<CallRecord | null>(null);
  readonly redisKind = signal<RedisKindFilter>('all');
  /** Opened commands (by seq) and unfolded groups (by key) of the Redis list - groups start folded. */
  readonly redisOpen = signal<ReadonlySet<number>>(new Set());
  readonly redisUnfolded = signal<ReadonlySet<string>>(new Set());
  /** The project's slow-command threshold (Settings → Redis), ms. */
  readonly redisSlowMillis = signal(10);
  /** The project's "show values as" (DECODED by default) - display only. */
  readonly redisShowRaw = signal(false);

  toggleRedisOpen(seq: number): void {
    const next = new Set(this.redisOpen());
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    this.redisOpen.set(next);
  }

  toggleRedisFold(key: string): void {
    const next = new Set(this.redisUnfolded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.redisUnfolded.set(next);
  }

  /** A Redis command under the Redis filters: kind, then the search over command, keys, arguments, reply and cache. */
  matchesRedis(c: StoreCommandSummary): boolean {
    switch (this.redisKind()) {
      case 'r':
        if (c.rw !== 'r') return false;
        break;
      case 'w':
        if (c.rw !== 'w') return false;
        break;
      case 'miss':
        if (c.outcome !== 'MISS') return false;
        break;
      case 'fail':
        if (c.outcome !== 'FAILED') return false;
        break;
    }
    const q = this.search().toLowerCase();
    if (!q) return true;
    return `${c.command} ${c.keys.join(' ')} ${c.argsText ?? ''} ${c.replyPreview ?? ''} ${c.origin?.cache ?? ''} ${c.origin?.method ?? ''} ${c.code ?? ''}`
      .toLowerCase().includes(q);
  }
}
