import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, Subject, share } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';
import { TeamTokenStore } from './team-token.store';
import {
  ConnectorInfo, MappingKind, SeedTarget, TeamBoard, TeamChange, TeamConnection, TeamFieldMap, TeamItemDetail, TeamItemFilters,
  TeamItemsPage, TeamMapping, TeamPerson, TeamRevision, TeamScope, TeamSocketEvent, TeamSprint, TeamSquad, StartTarget, StartAnswer, TeamLink,
} from './team.models';

/**
 * HTTP for /teamboards (specs/027 contracts/teamboards-rest.md). The viewer's token rides in X-Alfred-Team-Token only
 * on the calls that reach the provider (refresh, history, start) - never elsewhere, never to another prefix.
 */
@Injectable({ providedIn: 'root' })
export class TeamApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  private readonly tokens = inject(TeamTokenStore);

  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<TeamSocketEvent> = reconnectingSocket<TeamSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/teamboards`,
    () => this.reconnected$.next(),
  ).pipe(share());

  private get base(): string {
    return `${this.config.backendUrl}/teamboards`;
  }

  private withToken(conn: string): { headers: HttpHeaders } {
    let headers = new HttpHeaders();
    const token = this.tokens.get(conn);
    if (token) headers = headers.set('X-Alfred-Team-Token', token);
    const who = this.tokens.who();
    if (who) headers = headers.set('X-Alfred-Team-Who', who);
    return { headers };
  }

  connectors(): Observable<ConnectorInfo[]> {
    return this.http.get<ConnectorInfo[]>(`${this.base}/connectors`);
  }

  connections(): Observable<TeamConnection[]> {
    return this.http.get<TeamConnection[]>(`${this.base}/connections`);
  }

  createConnection(body: { kind: string; name: string; baseUrl: string; scope: TeamScope }): Observable<TeamConnection> {
    return this.http.post<TeamConnection>(`${this.base}/connections`, body);
  }

  updateConnection(id: string, body: { name?: string; scope?: TeamScope }): Observable<TeamConnection> {
    return this.http.patch<TeamConnection>(`${this.base}/connections/${encodeURIComponent(id)}`, body);
  }

  deleteConnection(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/connections/${encodeURIComponent(id)}`);
  }

  /**
   * Refresh. In the background (the Team tab): 202 STARTED at once, the outcome on /ws/teamboards (what: refresh) - a first
   * fetch can outlast a proxy's timeout. Else it answers when done: {changed, fetchedAt}.
   */
  refresh(conn: string, background = false): Observable<{ changed?: number; fetchedAt?: string; state?: 'STARTED'; message?: string }> {
    return this.http.post<{ changed?: number; fetchedAt?: string; state?: 'STARTED'; message?: string }>(
      `${this.base}/connections/${encodeURIComponent(conn)}/refresh`, {}, { ...this.withToken(conn), params: background ? { background: 'true' } : {} });
  }

  items(conn: string, filters: TeamItemFilters, offset = 0, limit = 50): Observable<TeamItemsPage> {
    let params = new HttpParams().set('offset', String(offset)).set('limit', String(limit));
    for (const [k, v] of Object.entries(filters)) if (v) params = params.set(k, String(v));
    return this.http.get<TeamItemsPage>(`${this.base}/connections/${encodeURIComponent(conn)}/items`, { params });
  }

  item(conn: string, extId: string): Observable<TeamItemDetail> {
    return this.http.get<TeamItemDetail>(`${this.base}/items/${encodeURIComponent(conn)}/${encodeURIComponent(extId)}`);
  }

  /** The cached history; with fetch, first reads it from the provider with this browser's token (a POST: a write). */
  revisions(conn: string, extId: string, fetch = false): Observable<TeamRevision[]> {
    const path = `${this.base}/items/${encodeURIComponent(conn)}/${encodeURIComponent(extId)}/revisions`;
    return fetch ? this.http.post<TeamRevision[]>(`${path}/fetch`, {}, this.withToken(conn)) : this.http.get<TeamRevision[]>(path);
  }

  boards(conn: string): Observable<TeamBoard[]> {
    return this.http.get<TeamBoard[]>(`${this.base}/connections/${encodeURIComponent(conn)}/boards`);
  }

  sprints(conn: string): Observable<TeamSprint[]> {
    return this.http.get<TeamSprint[]>(`${this.base}/connections/${encodeURIComponent(conn)}/sprints`);
  }

  squads(conn: string): Observable<TeamSquad[]> {
    return this.http.get<TeamSquad[]>(`${this.base}/connections/${encodeURIComponent(conn)}/squads`);
  }

  people(conn: string): Observable<TeamPerson[]> {
    return this.http.get<TeamPerson[]>(`${this.base}/connections/${encodeURIComponent(conn)}/people`);
  }

  mapSquad(conn: string, extId: string, alfredProject: string | null, alfredTeam: string | null): Observable<TeamSquad> {
    return this.http.patch<TeamSquad>(`${this.base}/squads/${encodeURIComponent(conn)}/${encodeURIComponent(extId)}`, { alfredProject, alfredTeam });
  }

  changes(conn: string, filters: { squad?: string; person?: string; after?: number }, limit = 100): Observable<TeamChange[]> {
    let params = new HttpParams().set('limit', String(limit));
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params = params.set(k, String(v));
    return this.http.get<TeamChange[]>(`${this.base}/connections/${encodeURIComponent(conn)}/changes`, { params });
  }

  markSeen(conn: string): Observable<void> {
    return this.http.post<void>(`${this.base}/connections/${encodeURIComponent(conn)}/seen`, {});
  }

  mappings(conn: string): Observable<TeamMapping[]> {
    return this.http.get<TeamMapping[]>(`${this.base}/connections/${encodeURIComponent(conn)}/mappings`);
  }

  putMapping(conn: string, kind: MappingKind, extValue: string, alfredProject: string, alfredBoard: string | null): Observable<TeamMapping> {
    return this.http.put<TeamMapping>(`${this.base}/connections/${encodeURIComponent(conn)}/mappings`, { kind, extValue, alfredProject, alfredBoard });
  }

  deleteMapping(conn: string, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/connections/${encodeURIComponent(conn)}/mappings/${id}`);
  }

  fieldMaps(conn: string): Observable<TeamFieldMap[]> {
    return this.http.get<TeamFieldMap[]>(`${this.base}/connections/${encodeURIComponent(conn)}/field-maps`);
  }

  putFieldMap(conn: string, itemType: string, field: string, target: SeedTarget): Observable<TeamFieldMap> {
    return this.http.put<TeamFieldMap>(`${this.base}/connections/${encodeURIComponent(conn)}/field-maps/${encodeURIComponent(itemType)}/${encodeURIComponent(field)}`,
      { target });
  }

  deleteFieldMap(conn: string, itemType: string, field: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/connections/${encodeURIComponent(conn)}/field-maps/${encodeURIComponent(itemType)}/${encodeURIComponent(field)}`);
  }

  // ------------------------------------------------------------------------------------- start and links (specs/027 US8/US9)

  /** The user's Start: 202 WAITING, 409 NEEDS_TARGET / ALREADY_STARTED. The token (when kept) also fetches the attachments. */
  start(conn: string, extId: string, target: StartTarget | null): Observable<StartAnswer> {
    return this.http.post<StartAnswer>(`${this.base}/items/${encodeURIComponent(conn)}/${encodeURIComponent(extId)}/start`, { target },
      this.withToken(conn));
  }

  cancelStart(conn: string, extId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/items/${encodeURIComponent(conn)}/${encodeURIComponent(extId)}/start`);
  }

  /** The board an Alfred board was opened from; null (204) when none. */
  link(boardId: string): Observable<TeamLink | null> {
    return this.http.get<TeamLink | null>(`${this.base}/links/${encodeURIComponent(boardId)}`);
  }

  linkSeen(boardId: string): Observable<void> {
    return this.http.post<void>(`${this.base}/links/${encodeURIComponent(boardId)}/seen`, {});
  }

  fetchAttachments(boardId: string, conn: string): Observable<{ attached: string[]; notAttached: string[] }> {
    return this.http.post<{ attached: string[]; notAttached: string[] }>(`${this.base}/links/${encodeURIComponent(boardId)}/attachments/fetch`, {},
      this.withToken(conn));
  }
}
