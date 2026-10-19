import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject, share } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';
import {
  BoardItemsView, CardItem, CardMatch, ConnectorInfo, SyncResult, HookInfo, IncomingRow, MainSummary, MappingKind, Markers, MineView, PersonCard, SearchResult,
  NewBoardBody, NewBoardResult, SeedTarget, SavedSearch, StartAnswer, StartWaiting, StartTarget, SyncRow, TeamConnection, TeamFieldMap, TeamItemView, TeamLists, TeamMapping, TeamMe, TeamPerson,
  TeamScope, TeamSearch, TeamSocketEvent, TeamSprint, TeamSquad, TeamBoard, TokenStatus, TypeKind, WatchRule, WriteBundle, WriteStep, BundleCheck,
} from './team.models';

const e = encodeURIComponent;

/**
 * HTTP for /teamboards (specs/028 contracts/teamboards-rest.md). The token goes to the backend once, in a PUT body, and
 * lives there in memory for 8 hours; no request carries it again and this browser never keeps it.
 */
@Injectable({ providedIn: 'root' })
export class TeamApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<TeamSocketEvent> = reconnectingSocket<TeamSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/teamboards`,
    () => this.reconnected$.next(),
  ).pipe(share());

  private get base(): string {
    return `${this.config.backendUrl}/teamboards`;
  }

  private conn(id: string): string {
    return `${this.base}/connections/${e(id)}`;
  }

  // ------------------------------------------------------------------------------------------------- connections

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
    return this.http.patch<TeamConnection>(this.conn(id), body);
  }

  deleteConnection(id: string): Observable<void> {
    return this.http.delete<void>(this.conn(id));
  }

  upgradeNotice(): Observable<{ show: boolean }> {
    return this.http.get<{ show: boolean }>(`${this.base}/upgrade-notice`);
  }

  dismissUpgradeNotice(): Observable<void> {
    return this.http.delete<void>(`${this.base}/upgrade-notice`);
  }

  // ------------------------------------------------------------------------------------------------------- token

  putToken(conn: string, token: string): Observable<TokenStatus> {
    return this.http.put<TokenStatus>(`${this.conn(conn)}/token`, { token: token.trim() });
  }

  tokenStatus(conn: string): Observable<TokenStatus> {
    return this.http.get<TokenStatus>(`${this.conn(conn)}/token`);
  }

  forgetToken(conn: string): Observable<void> {
    return this.http.delete<void>(`${this.conn(conn)}/token`);
  }

  // ----------------------------------------------------------------------------------------------------- lists

  lists(conn: string, maxAgeMinutes = 10): Observable<TeamLists> {
    return this.http.get<TeamLists>(`${this.conn(conn)}/lists`, { params: { maxAgeMinutes: String(maxAgeMinutes) } });
  }

  refreshLists(conn: string): Observable<TeamLists> {
    return this.http.post<TeamLists>(`${this.conn(conn)}/lists/refresh`, {});
  }

  boards(conn: string): Observable<TeamBoard[]> {
    return this.http.get<TeamBoard[]>(`${this.conn(conn)}/boards`);
  }

  sprints(conn: string): Observable<TeamSprint[]> {
    return this.http.get<TeamSprint[]>(`${this.conn(conn)}/sprints`);
  }

  squads(conn: string): Observable<TeamSquad[]> {
    return this.http.get<TeamSquad[]>(`${this.conn(conn)}/squads`);
  }

  people(conn: string): Observable<TeamPerson[]> {
    return this.http.get<TeamPerson[]>(`${this.conn(conn)}/people`);
  }

  person(conn: string, id: string): Observable<PersonCard> {
    return this.http.get<PersonCard>(`${this.conn(conn)}/people/${e(id)}`);
  }

  mapSquad(conn: string, extId: string, alfredProject: string | null, alfredTeam: string | null): Observable<TeamSquad> {
    return this.http.patch<TeamSquad>(`${this.base}/squads/${e(conn)}/${e(extId)}`, { alfredProject, alfredTeam });
  }

  me(conn: string): Observable<TeamMe | null> {
    return this.http.get<TeamMe | null>(`${this.conn(conn)}/me`);
  }

  putMe(conn: string, person: string): Observable<TeamMe> {
    return this.http.put<TeamMe>(`${this.conn(conn)}/me`, { person });
  }

  clearMe(conn: string): Observable<void> {
    return this.http.delete<void>(`${this.conn(conn)}/me`);
  }

  mine(conn: string): Observable<MineView> {
    return this.http.get<MineView>(`${this.conn(conn)}/mine`);
  }

  // ---------------------------------------------------------------------------------------------- search, items

  search(conn: string, body: TeamSearch): Observable<SearchResult> {
    return this.http.post<SearchResult>(`${this.conn(conn)}/search`, body);
  }

  query(conn: string, wiql: string, max = 200): Observable<SearchResult> {
    return this.http.post<SearchResult>(`${this.conn(conn)}/query`, { wiql, max });
  }

  /** {@code include}: comments, history, attachments (comma list); fields and relations always come. */
  item(conn: string, id: string, include = 'comments,attachments'): Observable<TeamItemView> {
    return this.http.get<TeamItemView>(`${this.conn(conn)}/items/${e(id)}`, { params: { include } });
  }

  items(conn: string, ids: string[], include = ''): Observable<TeamItemView[]> {
    return this.http.post<TeamItemView[]>(`${this.conn(conn)}/items`, { ids, include });
  }

  attachmentUrl(conn: string, id: string, name: string): string {
    return `${this.conn(conn)}/items/${e(id)}/attachments/${e(name)}`;
  }

  /** The user's own change - it goes to the tracker now and is recorded as a bundle. */
  /** The user's own write, sent at once: a state, a comment and/or one field by its reference name (specs/030). */
  direct(conn: string, id: string, body: { state?: string; comment?: string; field?: string; value?: string; board?: string | null; card?: string | null }): Observable<WriteBundle> {
    return this.http.patch<WriteBundle>(`${this.conn(conn)}/items/${e(id)}`, body);
  }

  // ------------------------------------------------------------------------------------------------ board items

  boardItems(board: string): Observable<BoardItemsView> {
    return this.http.get<BoardItemsView>(`${this.base}/boards/${e(board)}/items`);
  }

  addBoardItem(board: string, body: { conn: string; item?: string; url?: string; asMain?: boolean; maxRefs?: number }): Observable<BoardItemsView> {
    return this.http.post<BoardItemsView>(`${this.base}/boards/${e(board)}/items`, body);
  }

  setMain(board: string, conn: string, item: string, maxRefs?: number): Observable<{ view: BoardItemsView; reseedOffer: boolean; oldMain: string | null }> {
    return this.http.put<{ view: BoardItemsView; reseedOffer: boolean; oldMain: string | null }>(`${this.base}/boards/${e(board)}/main`,
      { conn, item, maxRefs });
  }

  unlinkBoardItem(board: string, conn: string, item: string, newMain?: string): Observable<BoardItemsView> {
    const params = newMain ? new HttpParams().set('newMain', newMain) : undefined;
    return this.http.delete<BoardItemsView>(`${this.base}/boards/${e(board)}/items/${e(conn)}/${e(item)}`, { params });
  }

  sync(board: string, force = false): Observable<{ state: string }> {
    return this.http.post<{ state: string }>(`${this.base}/boards/${e(board)}/sync`, { force });
  }

  /** "↻ Refresh from Azure" (specs/030): syncs now and answers with what changed. */
  refresh(board: string): Observable<SyncResult> {
    return this.http.post<SyncResult>(`${this.base}/boards/${e(board)}/sync`, { force: true, wait: true });
  }

  keep(board: string, conn: string, item: string): Observable<BoardItemsView> {
    return this.http.post<BoardItemsView>(`${this.base}/boards/${e(board)}/items/${e(conn)}/${e(item)}/keep`, {});
  }

  syncs(board: string, conn: string, item: string): Observable<SyncRow[]> {
    return this.http.get<SyncRow[]>(`${this.base}/boards/${e(board)}/items/${e(conn)}/${e(item)}/syncs`);
  }

  /** A board's tracker side for its export (specs/028 FR-112): one record per line. */
  boardExport(board: string): Observable<(Record<string, unknown> & { record: string })[]> {
    return this.http.get<(Record<string, unknown> & { record: string })[]>(`${this.base}/boards/${e(board)}/export`);
  }

  mainOf(board: string): Observable<MainSummary | null> {
    return this.http.get<MainSummary | null>(`${this.base}/boards/${e(board)}/main`);
  }

  // ---------------------------------------------------------------------------------------------------- incoming

  incoming(board: string): Observable<IncomingRow[]> {
    return this.http.get<IncomingRow[]>(`${this.base}/boards/${e(board)}/incoming`);
  }

  addIncoming(board: string, conn: string, item: string): Observable<IncomingRow> {
    return this.http.post<IncomingRow>(`${this.base}/boards/${e(board)}/incoming`, { conn, item });
  }

  incomingCard(board: string, conn: string, item: string, markers = false): Observable<{ cardId: string }> {
    return this.http.post<{ cardId: string }>(`${this.base}/boards/${e(board)}/incoming/${e(conn)}/${e(item)}/card`, { markers });
  }

  incomingLink(board: string, conn: string, item: string, cardId: string, markers = false): Observable<void> {
    return this.http.post<void>(`${this.base}/boards/${e(board)}/incoming/${e(conn)}/${e(item)}/link`, { cardId, markers });
  }

  incomingIgnore(board: string, conn: string, item: string): Observable<void> {
    return this.http.post<void>(`${this.base}/boards/${e(board)}/incoming/${e(conn)}/${e(item)}/ignore`, {});
  }

  // ------------------------------------------------------------------------------------------------- watch rules

  rules(board: string): Observable<WatchRule[]> {
    return this.http.get<WatchRule[]>(`${this.base}/boards/${e(board)}/watch-rules`);
  }

  addRule(board: string, body: { name: string; conn: string; query: TeamSearch }): Observable<WatchRule> {
    return this.http.post<WatchRule>(`${this.base}/boards/${e(board)}/watch-rules`, body);
  }

  deleteRule(board: string, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/boards/${e(board)}/watch-rules/${id}`);
  }

  runRules(board: string, source: 'OPEN' | 'REFRESH' = 'REFRESH'): Observable<{ new: number }> {
    return this.http.post<{ new: number }>(`${this.base}/boards/${e(board)}/watch-rules/run`, {}, { params: { source } });
  }

  // ------------------------------------------------------------------------------------------------------- cards

  cardItems(card: string): Observable<CardItem[]> {
    return this.http.get<CardItem[]>(`${this.base}/cards/${e(card)}/items`);
  }

  linkCard(card: string, conn: string, item: string, markers: Markers): Observable<{ items: CardItem[]; bundle: WriteBundle | null }> {
    return this.http.post<{ items: CardItem[]; bundle: WriteBundle | null }>(`${this.base}/cards/${e(card)}/items`, { conn, item, markers });
  }

  createFromCard(card: string, body: { conn: string; type: string; title: string; description?: string; area?: string; iteration?: string;
    assignee?: string; project?: string; markers?: Markers }): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/cards/${e(card)}/create`, body);
  }

  /** The items proposed for a card with none (specs/030), best first. */
  cardMatches(card: string): Observable<CardMatch[]> {
    return this.http.get<CardMatch[]>(`${this.base}/cards/${e(card)}/matches`);
  }

  linkMatch(card: string, conn: string, item: string): Observable<CardItem[]> {
    return this.http.post<CardItem[]>(`${this.base}/cards/${e(card)}/matches/${e(conn)}/${e(item)}/link`, {});
  }

  /** "Not this one": kept, never proposed again for this card. */
  rejectMatch(card: string, conn: string, item: string): Observable<CardMatch[]> {
    return this.http.post<CardMatch[]>(`${this.base}/cards/${e(card)}/matches/${e(conn)}/${e(item)}/reject`, {});
  }

  unlinkCard(card: string, conn: string, item: string): Observable<{ items: CardItem[]; bundle: WriteBundle | null }> {
    return this.http.delete<{ items: CardItem[]; bundle: WriteBundle | null }>(`${this.base}/cards/${e(card)}/items/${e(conn)}/${e(item)}`);
  }

  // ----------------------------------------------------------------------------------------------------- bundles

  bundles(filter: { board?: string; card?: string; state?: string }): Observable<WriteBundle[]> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(filter)) if (v) params = params.set(k, v);
    return this.http.get<WriteBundle[]>(`${this.base}/writes`, { params });
  }

  createBundle(body: { board?: string | null; card?: string | null; conn: string; item?: string | null; title: string; steps: WriteStep[] }): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/writes`, body);
  }

  editBundle(id: number, body: { title?: string; steps: WriteStep[] }): Observable<WriteBundle> {
    return this.http.put<WriteBundle>(`${this.base}/writes/${id}`, body);
  }

  bundleFile(id: number, step: number, name: string, file: Blob): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/writes/${id}/files`, file, {
      params: { step: String(step), name }, headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  approve(id: number): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/writes/${id}/approve`, {});
  }

  reject(id: number, reason?: string): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/writes/${id}/reject`, reason ? { reason } : {});
  }

  /** What the bundle meets in the tracker now (specs/034) - a live read with the viewer's token. */
  checkBundle(id: number): Observable<BundleCheck> {
    return this.http.get<BundleCheck>(`${this.base}/writes/${id}/check`);
  }

  /** Asks Claude to change a comment step: a waiting message in the board's chat (specs/034). */
  askRedraft(id: number, step: number, instruction: string): Observable<{ message: number | null }> {
    return this.http.post<{ message: number | null }>(`${this.base}/writes/${id}/redraft`, { step, instruction });
  }

  retryStep(id: number, step: number): Observable<WriteBundle> {
    return this.http.post<WriteBundle>(`${this.base}/writes/${id}/steps/${step}/retry`, {});
  }

  // ------------------------------------------------------------------------------------------- hook, type kinds

  hook(conn: string): Observable<HookInfo> {
    return this.http.get<HookInfo>(`${this.conn(conn)}/hook`);
  }

  putHook(conn: string, publicAddress: string | null): Observable<HookInfo> {
    return this.http.put<HookInfo>(`${this.conn(conn)}/hook`, { publicAddress });
  }

  rotateHookSecret(conn: string): Observable<{ secret: string }> {
    return this.http.post<{ secret: string }>(`${this.conn(conn)}/hook/secret`, {});
  }

  typeKinds(conn: string): Observable<TypeKind[]> {
    return this.http.get<TypeKind[]>(`${this.conn(conn)}/type-kinds`);
  }

  putTypeKind(conn: string, type: string, kind: string): Observable<TypeKind> {
    return this.http.put<TypeKind>(`${this.conn(conn)}/type-kinds`, { type, kind });
  }

  // ------------------------------------------------------------------------------------------- mappings, fields

  mappings(conn: string): Observable<TeamMapping[]> {
    return this.http.get<TeamMapping[]>(`${this.conn(conn)}/mappings`);
  }

  putMapping(conn: string, kind: MappingKind, extValue: string, alfredProject: string, alfredBoard: string | null): Observable<TeamMapping> {
    return this.http.put<TeamMapping>(`${this.conn(conn)}/mappings`, { kind, extValue, alfredProject, alfredBoard });
  }

  deleteMapping(conn: string, id: number): Observable<void> {
    return this.http.delete<void>(`${this.conn(conn)}/mappings/${id}`);
  }

  fieldMaps(conn: string): Observable<TeamFieldMap[]> {
    return this.http.get<TeamFieldMap[]>(`${this.conn(conn)}/field-maps`);
  }

  putFieldMap(conn: string, itemType: string, field: string, target: SeedTarget): Observable<TeamFieldMap> {
    return this.http.put<TeamFieldMap>(`${this.conn(conn)}/field-maps/${e(itemType)}/${e(field)}`, { target });
  }

  deleteFieldMap(conn: string, itemType: string, field: string): Observable<void> {
    return this.http.delete<void>(`${this.conn(conn)}/field-maps/${e(itemType)}/${e(field)}`);
  }

  // ---------------------------------------------------------------------------------------------- start (027)

  /** The user's Start: 202 WAITING, 409 NEEDS_TARGET / ALREADY_STARTED. The live token also fetches the attachments. */
  start(conn: string, extId: string, target: StartTarget | null): Observable<StartAnswer> {
    return this.http.post<StartAnswer>(`${this.base}/items/${e(conn)}/${e(extId)}/start`, { target });
  }

  /** A board made from the item now (201): the board, its first cycle and the main link together. */
  newBoardFromItem(conn: string, extId: string, body: NewBoardBody): Observable<NewBoardResult> {
    return this.http.post<NewBoardResult>(`${this.base}/items/${e(conn)}/${e(extId)}/board`, body);
  }

  /** The Alfred project a mapping names for the item (204: none). */
  itemTarget(conn: string, extId: string): Observable<{ project: string | null; boardId: string | null } | null> {
    return this.http.get<{ project: string | null; boardId: string | null } | null>(`${this.base}/items/${e(conn)}/${e(extId)}/target`);
  }

  // ------------------------------------------------------------------------------------------ saved searches (029)

  savedSearches(conn: string): Observable<SavedSearch[]> {
    return this.http.get<SavedSearch[]>(`${this.base}/connections/${e(conn)}/saved`);
  }

  createSaved(conn: string, name: string, query: TeamSearch): Observable<SavedSearch> {
    return this.http.post<SavedSearch>(`${this.base}/connections/${e(conn)}/saved`, { name, query });
  }

  updateSaved(id: number, body: { name?: string; query?: TeamSearch }): Observable<SavedSearch> {
    return this.http.patch<SavedSearch>(`${this.base}/saved/${id}`, body);
  }

  moveSaved(id: number, by: -1 | 1): Observable<SavedSearch[]> {
    return this.http.post<SavedSearch[]>(`${this.base}/saved/${id}/move`, { by });
  }

  deleteSaved(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/saved/${id}`);
  }

  /** The start waiting for this item, or null (204). */
  waitingStart(conn: string, extId: string): Observable<StartWaiting | null> {
    return this.http.get<StartWaiting | null>(`${this.base}/items/${e(conn)}/${e(extId)}/start`);
  }

  cancelStart(conn: string, extId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/items/${e(conn)}/${e(extId)}/start`);
  }

  fetchAttachments(boardId: string): Observable<{ attached: string[]; notAttached: string[] }> {
    return this.http.post<{ attached: string[]; notAttached: string[] }>(`${this.base}/links/${e(boardId)}/attachments/fetch`, {});
  }
}
