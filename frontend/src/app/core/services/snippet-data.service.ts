import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, debounceTime, filter, firstValueFrom, map, merge, share } from 'rxjs';
import { reconnectingSocket } from '../state/reconnecting-socket';
import { callOf } from '../../shared/utils/mention-syntax';
import { AppConfigService } from './app-config.service';
import { BoardApiService } from './board-api.service';
import { BoardSocketService } from './board-socket.service';
import { CallLogsApiService } from './call-logs-api.service';
import { CallsApiService } from './calls-api.service';
import { DbCaptureApiService } from './db-capture-api.service';
import { InterceptionApiService } from './interception-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

/** What `alfred.data(src)` may read (specs/017 R17): Alfred's own GET endpoints, nothing else. */
export const DATA_SOURCES = ['calls', 'call', 'statements', 'rows', 'logs', 'redis', 'cards', 'card', 'cycles', 'rules'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/** One call as /board/data/calls lists it. */
export interface DataCallRow {
  readonly ref: string;
  readonly project: string | null;
  readonly method: string;
  readonly path: string;
  readonly endpoint: string;
  readonly status: number | null;
  readonly signal: string;
  readonly at: string | null;
  readonly durationMs: number | null;
  readonly statements: number | null;
  readonly writes: number | null;
  readonly failedStatements: number | null;
  readonly dbMs: number | null;
  readonly errors: number | null;
  readonly warnings: number | null;
}

/** Where the asking snippet lives: what `since: "fix"` and an omitted project mean. */
export interface DataContext {
  readonly project?: string | null;
  readonly cardId?: string | null;
  readonly cycleId?: string | null;
}

const STR = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

/**
 * The read bridge's host side (specs/017 R17-R20): each source name maps to one of Alfred's GET endpoints, arguments
 * are read as plain values, and nothing else is reachable - a snippet cannot name a URL. Live: a source changes when
 * calls arrive (/ws/internal-calls, /ws/calls) or the board changes (/ws/board) - a signal, then a re-read, never a poll.
 */
@Injectable({ providedIn: 'root' })
export class SnippetDataService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly board = inject(BoardApiService);
  private readonly rules = inject(InterceptionApiService);
  private readonly boardSocket = inject(BoardSocketService);
  private callsChanged$: Observable<void> | null = null;

  /** Reads one source. Throws an Error a snippet can show for an unknown source or missing argument. */
  async read(src: string, args: Record<string, unknown>, ctx: DataContext = {}): Promise<unknown> {
    switch (src as DataSource) {
      case 'calls': return this.callRows(args, ctx);
      case 'call': {
        const c = this.ref(args);
        const detail = c.cycleId
          ? this.cycles.getDetail(c.cycleId, c.id, c.direction === 'in' ? 'internal' : 'external')
          : this.calls.getDetail(c.id, c.direction === 'in' ? 'internal' : 'external');
        return firstValueFrom(detail);
      }
      case 'statements': return firstValueFrom(this.db.statements(this.ref(args).id, 0, num(args['limit'], 500, 5000)));
      case 'rows': {
        const id = num(args['statement'] ?? args['id'], NaN, Number.MAX_SAFE_INTEGER);
        if (!Number.isFinite(id)) throw new Error('rows needs { statement: <id> }');
        const part = STR(args['part']).toUpperCase() || 'RESULT';
        return firstValueFrom(this.db.rows(id, part as never, num(args['offset'], 0, 1e9), num(args['limit'], 200, 2000)));
      }
      case 'logs': {
        const c = this.ref(args);
        return firstValueFrom(this.logs.allLines(c.id, c.cycleId));
      }
      case 'redis': return firstValueFrom(this.db.storeCommands(this.ref(args).id, 0, num(args['limit'], 500, 5000)));
      case 'cards': {
        const project = STR(args['project']) || ctx.project || '';
        if (!project) throw new Error('cards needs { project }');
        const page = await firstValueFrom(this.board.cards(project, STR(args['cycle']) || null,
          { kinds: [], flags: [], author: null, scopeNotDecided: false, q: STR(args['q']) }, 0, num(args['limit'], 200, 500)));
        return page.cards;
      }
      case 'card': {
        if (args['number'] != null) return firstValueFrom(this.board.cardByNumber(STR(args['project']) || ctx.project || '', num(args['number'], 0, 1e9)));
        const id = STR(args['id']) || ctx.cardId || '';
        if (!id) throw new Error('card needs { number } or { id }');
        return firstValueFrom(this.board.card(id));
      }
      case 'cycles': return firstValueFrom(this.cycles.list());
      case 'rules': return firstValueFrom(this.rules.listRules());
      default: throw new Error(`alfred.data: "${src}" is not a source - use one of ${DATA_SOURCES.join(', ')}`);
    }
  }

  /** When a source's answer may have changed: a debounced signal, so a burst of calls is one re-read. */
  changes(src: string): Observable<void> {
    const board$ = this.boardSocket.events$.pipe(filter((e) => e.type === 'board-changed'), map(() => undefined));
    switch (src as DataSource) {
      case 'calls': case 'statements': case 'logs': case 'redis': case 'call': return this.callsSignal();
      case 'cards': case 'card': return board$.pipe(debounceTime(300));
      case 'cycles': return merge(this.callsSignal(), board$).pipe(debounceTime(500));
      default: return new Observable<void>();
    }
  }

  private callsSignal(): Observable<void> {
    if (!this.callsChanged$) {
      const ws = this.config.backendUrl.replace(/^http/, 'ws');
      this.callsChanged$ = merge(reconnectingSocket<unknown>(`${ws}/ws/internal-calls`, () => undefined),
        reconnectingSocket<unknown>(`${ws}/ws/calls`, () => undefined)).pipe(debounceTime(1000), map(() => undefined), share());
    }
    return this.callsChanged$;
  }

  private async callRows(args: Record<string, unknown>, ctx: DataContext): Promise<DataCallRow[]> {
    let params = new HttpParams();
    const project = STR(args['project']) || ctx.project || '';
    if (project) params = params.set('project', project);
    for (const k of ['endpoint', 'signal', 'until', 'cycle'] as const) if (STR(args[k])) params = params.set(k, STR(args[k]));
    const since = await this.since(STR(args['since']), ctx);
    if (since) params = params.set('since', since);
    params = params.set('limit', num(args['limit'], 200, 1000));
    const page = await firstValueFrom(this.http.get<{ calls: DataCallRow[] }>(`${this.config.backendUrl}/board/data/calls`, { params }));
    return page.calls;
  }

  /** `since`: an ISO time, `call:<ref>` (that call's time), `fix` (when this card was last moved to Fixed) or `24h`/`30m`. */
  async since(v: string, ctx: DataContext): Promise<string | null> {
    if (!v) return null;
    const rel = /^(\d+)\s*([mhd])$/i.exec(v);
    if (rel) return new Date(Date.now() - Number(rel[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[rel[2].toLowerCase() as 'm']).toISOString();
    if (v === 'fix') {
      if (!ctx.cardId) throw new Error('since: "fix" is for a snippet on a card');
      const page = await firstValueFrom(this.board.activity(ctx.cardId, 0, 1000));
      const fixed = [...page.entries].reverse().find((e) => e.kind === 'STATUS' && e.newValue === 'FIXED');
      if (!fixed) throw new Error('This card was never moved to Fixed');
      return fixed.at;
    }
    if (v.startsWith('call:')) {
      const c = this.ref({ ref: v.slice(5) });
      const s = await firstValueFrom(this.calls.getSummary(c.id, c.direction === 'in' ? 'internal' : 'external'));
      return s.timestamp ?? null;
    }
    if (Number.isNaN(Date.parse(v))) throw new Error(`since: "${v}" is an ISO time, call:<ref>, fix, or like 24h`);
    return new Date(v).toISOString();
  }

  private ref(args: Record<string, unknown>): { direction: 'in' | 'out'; id: string; cycleId: string | null } {
    const ref = STR(args['ref'] ?? args['call']).replace(/^@?\[?call:/, '').replace(/\|.*$/, '');
    const c = callOf({ type: 'CALL', ref, label: '' } as never);
    if (!c || !c.id) throw new Error('Name the call: { ref: "in:<id>" } (a call mention\'s ref)');
    return c;
  }
}

function num(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? Math.max(0, Math.min(max, Math.floor(n))) : fallback;
}
