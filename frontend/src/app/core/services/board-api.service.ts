import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ActivityPage, AgentStatus, LiveWork, BoardAccess, BoardFilters, BoardStorage, BulkAction, CallBadge, CardDetail, CardEdit, CardStatus, CardsPage,
  CardRetest, ChecklistFile, ChecklistItem, CycleBrief, Expectation, Mark, MentionRef, NewCard, NextSteps, Resolution, RetestCheck, RetestPlan,
  RetestReport, RetestStep, SessionLogEntry, SpecFileInfo, Team, TeamEdit, TestStep,
  CycleChatInfo, EvidenceCheck, ItemEvidence, RequirementsView, SkillRun, SkillRunRequest, SkillRunsPage, TextVersion,
  ActivityEntry, BoardQuestion, BriefComment, EntryAnswers, LiveRunnerInfo, ItemCall,
} from '../models/board.models';
import { AppConfigService } from './app-config.service';

/** HTTP for /board (specs/014-task-board contracts/rest-api.md). */
@Injectable({ providedIn: 'root' })
export class BoardApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/board`;
  }

  access(): Observable<BoardAccess> {
    return this.http.get<BoardAccess>(`${this.base}/access`);
  }

  cards(project: string, cycleId: string | null, filters: BoardFilters, offset = 0, limit = 500): Observable<CardsPage> {
    let params = new HttpParams().set('project', project).set('offset', offset).set('limit', limit);
    if (cycleId) params = params.set('cycleId', cycleId);
    if (filters.kinds.length) params = params.set('kind', filters.kinds.join(','));
    if (filters.flags.length) params = params.set('flag', filters.flags.join(','));
    if (filters.author) params = params.set('author', filters.author);
    if (filters.scopeNotDecided) params = params.set('scopeNotDecided', true);
    if (filters.q.trim()) params = params.set('q', filters.q.trim());
    if (filters.waiting) params = params.set('waiting', filters.waiting);
    if (filters.cycleDeleted) params = params.set('cycleDeleted', true);
    if (filters.teams?.length) params = params.set('team', filters.teams.join(','));
    return this.http.get<CardsPage>(`${this.base}/cards`, { params });
  }

  card(id: string): Observable<CardDetail> {
    return this.http.get<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}`);
  }

  cardByNumber(project: string, number: number): Observable<CardDetail> {
    return this.http.get<CardDetail>(`${this.base}/cards/by-number/${number}`, { params: { project } });
  }

  create(card: NewCard): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards`, card);
  }

  quickAdd(project: string, cycleId: string | null, text: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/quick`, { project, cycleId, text });
  }

  // ---------------------------------------------------------------------------------------------------- teams

  teams(): Observable<Team[]> {
    return this.http.get<Team[]>(`${this.base}/teams`);
  }

  createTeam(edit: TeamEdit): Observable<Team> {
    return this.http.post<Team>(`${this.base}/teams`, edit);
  }

  updateTeam(id: string, edit: TeamEdit): Observable<Team> {
    return this.http.put<Team>(`${this.base}/teams/${encodeURIComponent(id)}`, edit);
  }

  deleteTeam(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/teams/${encodeURIComponent(id)}`);
  }

  reorderTeams(ids: readonly string[]): Observable<Team[]> {
    return this.http.put<Team[]>(`${this.base}/teams/order`, { ids });
  }

  /** Replaces the card's teams; recorded in its history with the reason. */
  assignTeams(id: string, teams: readonly string[], reason?: string): Observable<CardDetail> {
    return this.http.put<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/teams`, { teams, reason: reason ?? null });
  }

  update(id: string, edit: CardEdit): Observable<CardDetail> {
    return this.http.patch<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}`, edit);
  }

  move(id: string, status: CardStatus): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/move`, { status });
  }

  close(id: string, resolution: Resolution, reason?: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/close`, { resolution, reason });
  }

  /** Merge this card into card #`intoNumber` of the project: its history and links move there, it closes as a duplicate. */
  merge(id: string, intoNumber: number, reason?: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/merge`, { intoNumber, reason });
  }

  reopen(id: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/reopen`, {});
  }

  setReason(id: string, reason: string): Observable<CardDetail> {
    return this.http.put<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/reason`, { reason });
  }

  undoClose(id: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/undo-close`, {});
  }

  /** Deletes every card of a cycle - the user deleting the cycle with its cards. */
  deleteCycleCards(cycleId: string): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/cards`);
  }

  storage(): Observable<BoardStorage> {
    return this.http.get<BoardStorage>(`${this.base}/storage`);
  }

  compact(): Observable<{ before: BoardStorage; after: BoardStorage }> {
    return this.http.post<{ before: BoardStorage; after: BoardStorage }>(`${this.base}/storage/compact`, {});
  }

  bulk(ids: readonly string[], action: BulkAction, reason?: string): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>(`${this.base}/cards/bulk`, { ids, action, reason });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/cards/${encodeURIComponent(id)}`);
  }

  link(id: string, mention: MentionRef): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/links`, mention);
  }

  unlink(id: string, type: string, ref: string): Observable<CardDetail> {
    return this.http.delete<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/links`, { body: { type, ref } });
  }

  activity(id: string, offset = 0, limit = 1000): Observable<ActivityPage> {
    return this.http.get<ActivityPage>(`${this.base}/cards/${encodeURIComponent(id)}/activity`, { params: { offset, limit } });
  }

  /** A comment, or with `replyTo` a reply to one; `clearDecision` on an answer to Claude's question takes Needs decision off. */
  comment(id: string, text: string, replyTo?: number, clearDecision?: boolean): Observable<unknown> {
    return this.http.post(`${this.base}/cards/${encodeURIComponent(id)}/comments`,
      replyTo == null ? { text } : { text, replyTo, clearDecision: !!clearDecision });
  }

  /** Who answers the user on a project's board now - /alfred-live or /alfred-listen's live lane - or null (specs/020). */
  liveRunner(project: string): Observable<LiveRunnerInfo | null> {
    return this.http.get<LiveRunnerInfo | null>(`${this.base}/live-runner`, { params: { project } });
  }

  /** Every question Claude asked on a card, with its state (specs/019). */
  questions(id: string): Observable<BoardQuestion[]> {
    return this.http.get<BoardQuestion[]>(`${this.base}/cards/${encodeURIComponent(id)}/questions`);
  }

  /** Cards of a project (or a cycle) with open questions, and the total: the nav's ❓ count. */
  openQuestions(project: string, cycleId?: string | null): Observable<{ cards: Record<string, number>; total: number }> {
    return this.http.get<{ cards: Record<string, number>; total: number }>(`${this.base}/questions`,
      { params: cycleId ? { project, cycleId } : { project } });
  }

  /** One send of the questions dialog: every answer at once, one answer comment per question comment. */
  answers(id: string, answers: readonly EntryAnswers[], clearDecision = true): Observable<{ entries: ActivityEntry[] }> {
    return this.http.post<{ entries: ActivityEntry[] }>(`${this.base}/cards/${encodeURIComponent(id)}/answers`, { answers, clearDecision });
  }

  cycleBadges(cycleId: string): Observable<Record<string, CallBadge[]>> {
    return this.http.get<Record<string, CallBadge[]>>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/call-badges`);
  }

  /** At most 100 ids per request - callers chunk. */
  callBadges(callIds: readonly string[]): Observable<Record<string, CallBadge[]>> {
    return this.http.get<Record<string, CallBadge[]>>(`${this.base}/call-badges`, { params: { callIds: callIds.join(',') } });
  }

  brief(cycleId: string): Observable<CycleBrief> {
    return this.http.get<CycleBrief>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/brief`);
  }

  putBrief(cycleId: string, text: string): Observable<CycleBrief> {
    return this.http.put<CycleBrief>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/brief`, { text });
  }

  specs(cycleId: string): Observable<SpecFileInfo[]> {
    return this.http.get<SpecFileInfo[]>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/specs`);
  }

  specUrl(cycleId: string, name: string): string {
    return `${this.base}/cycles/${encodeURIComponent(cycleId)}/specs/${encodeURIComponent(name)}`;
  }

  spec(cycleId: string, name: string): Observable<string> {
    return this.http.get(this.specUrl(cycleId, name), { responseType: 'text' });
  }

  putSpec(cycleId: string, name: string, content: string | Blob): Observable<{ name: string; size: number; uploadedAt: string; replaced: boolean }> {
    return this.http.put<{ name: string; size: number; uploadedAt: string; replaced: boolean }>(this.specUrl(cycleId, name), content,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  deleteSpec(cycleId: string, name: string): Observable<void> {
    return this.http.delete<void>(this.specUrl(cycleId, name));
  }

  checklist(cycleId: string): Observable<ChecklistFile[]> {
    return this.http.get<ChecklistFile[]>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/checklist`);
  }

  /** specs/018: each Acceptance item's verdict by the calls (reading judges what is new first). */
  requirements(cycleId: string): Observable<RequirementsView> {
    return this.http.get<RequirementsView>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/requirements`);
  }

  /** specs/021: the calls judged for one Acceptance item, newest first. */
  itemCalls(cycleId: string, fileName: string, itemKey: string): Observable<{ calls: ItemCall[] }> {
    return this.http.get<{ calls: ItemCall[] }>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/requirements/calls`, { params: { fileName, itemKey } });
  }

  /** specs/021: an Acceptance item's short name; blank clears it. */
  setItemShortName(cycleId: string, fileName: string, itemKey: string, shortName: string): Observable<{ shortName: string }> {
    return this.http.put<{ shortName: string }>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/requirements/short-name`, { fileName, itemKey, shortName });
  }

  /** specs/021: a card's short name; blank clears it. */
  setCardShortName(id: string, shortName: string): Observable<CardDetail> {
    return this.http.put<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/short-name`, { shortName });
  }

  putEvidence(cycleId: string, evidence: { fileName: string; itemKey: string; project: string; endpoint: string;
                                          checks: readonly EvidenceCheck[]; howTo: string }): Observable<ItemEvidence> {
    return this.http.put<ItemEvidence>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/evidence`, evidence);
  }

  deleteEvidence(cycleId: string, fileName: string, itemKey: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/evidence`, { params: { fileName, itemKey } });
  }

  mark(cycleId: string, fileName: string, itemKey: string, mark: Mark, evidence: string): Observable<ChecklistItem> {
    return this.http.put<ChecklistItem>(
      `${this.base}/cycles/${encodeURIComponent(cycleId)}/checklist/${encodeURIComponent(fileName)}/${encodeURIComponent(itemKey)}`,
      { mark, evidence });
  }

  private suggestionUrl(cycleId: string, fileName: string, itemKey: string): string {
    return `${this.base}/cycles/${encodeURIComponent(cycleId)}/checklist/${encodeURIComponent(fileName)}/${encodeURIComponent(itemKey)}/suggestion`;
  }

  acceptSuggestion(cycleId: string, fileName: string, itemKey: string): Observable<ChecklistItem> {
    return this.http.post<ChecklistItem>(`${this.suggestionUrl(cycleId, fileName, itemKey)}/accept`, {});
  }

  dismissSuggestion(cycleId: string, fileName: string, itemKey: string): Observable<ChecklistItem> {
    return this.http.delete<ChecklistItem>(this.suggestionUrl(cycleId, fileName, itemKey));
  }

  /** What one board waits on: the next-step bar. */
  // ---------------------------------------------------------------------------------------------- re-test (specs/016)

  retestChecks(project: string, numbers: readonly number[] = [], cycleId: string | null = null): Observable<{ checks: RetestCheck[]; lastStart: string | null }> {
    const params: Record<string, string> = { project, numbers: numbers.join(',') };
    if (cycleId) params['cycleId'] = cycleId;
    return this.http.get<{ checks: RetestCheck[]; lastStart: string | null }>(`${this.base}/retest`, { params });
  }

  retestRun(project: string, numbers: readonly number[], cycleId: string | null): Observable<RetestReport> {
    return this.http.post<RetestReport>(`${this.base}/retest/run`, { project, numbers, cycleId });
  }

  retestGuards(project: string): Observable<RetestCheck[]> {
    return this.http.get<RetestCheck[]>(`${this.base}/retest/guards`, { params: { project } });
  }

  cardRetest(cardId: string, cycleId: string | null = null): Observable<CardRetest> {
    return this.http.get<CardRetest>(`${this.base}/cards/${encodeURIComponent(cardId)}/retest`, { params: cycleId ? { cycleId } : {} });
  }

  setRetestPlan(cardId: string, expectations: readonly Expectation[], steps: readonly RetestStep[]): Observable<RetestPlan> {
    return this.http.put<RetestPlan>(`${this.base}/cards/${encodeURIComponent(cardId)}/retest-plan`, { expectations, steps });
  }

  nextSteps(project: string, cycleId: string | null): Observable<NextSteps> {
    return this.http.get<NextSteps>(`${this.base}/next-steps`, { params: cycleId ? { project, cycleId } : { project } });
  }

  restoreBrief(cycleId: string): Observable<CycleBrief> {
    return this.http.post<CycleBrief>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/brief/restore`, {});
  }

  briefComments(cycleId: string): Observable<BriefComment[]> {
    return this.http.get<BriefComment[]>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/brief/comments`);
  }

  addBriefComment(cycleId: string, comment: { quote?: string | null; text: string; replyTo?: number | null }): Observable<{ comment: BriefComment }> {
    return this.http.post<{ comment: BriefComment }>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/brief/comments`, comment);
  }

  /** resolve / reopen / apply (Claude's rewording into the brief) / dismiss (the rewording). */
  briefCommentAction(cycleId: string, id: number, action: 'resolve' | 'reopen' | 'apply' | 'dismiss'): Observable<{ comment: BriefComment; brief?: CycleBrief }> {
    return this.http.post<{ comment: BriefComment; brief?: CycleBrief }>(
      `${this.base}/cycles/${encodeURIComponent(cycleId)}/brief/comments/${id}/${action}`, {});
  }

  restoreSpec(cycleId: string, name: string): Observable<SpecFileInfo> {
    return this.http.post<SpecFileInfo>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/specs/${encodeURIComponent(name)}/restore`, {});
  }

  steps(cycleId: string): Observable<TestStep[]> {
    return this.http.get<TestStep[]>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/steps`);
  }

  sessionLog(cycleId: string, limit = 20): Observable<SessionLogEntry[]> {
    return this.http.get<SessionLogEntry[]>(`${this.base}/cycles/${encodeURIComponent(cycleId)}/log`, { params: { limit } });
  }

  block(id: string, number: number): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/blocked-by`, { number });
  }

  unblock(id: string, number: number): Observable<CardDetail> {
    return this.http.delete<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/blocked-by/${number}`);
  }

  /** Changes after a cursor (the desktop notifications read Claude's new questions and proposals here). */
  changes(cursor: string, actor?: 'USER' | 'CLAUDE', limit = 50): Observable<{ entries: (ActivityEntryLike)[]; cursor: string }> {
    return this.http.get<{ entries: ActivityEntryLike[]; cursor: string }>(`${this.base}/changes`,
      { params: actor ? { cursor, actor, limit } : { cursor, limit } });
  }

  /** Takes Claude's proposed step as the user's own (moves or closes the card). */
  acceptProposal(id: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/proposal/accept`, {});
  }

  dismissProposal(id: string): Observable<CardDetail> {
    return this.http.delete<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/proposal`);
  }

  /** /alfred-live's work on cards: running, and recently ended. */
  liveWork(project?: string): Observable<LiveWork[]> {
    const params = project === undefined ? new HttpParams() : new HttpParams().set('project', project);
    return this.http.get<LiveWork[]>(`${this.base}/live-work`, { params });
  }

  /** The user's Stop on one live answer; the runner ends it at its next report. */
  stopLiveWork(id: string): Observable<LiveWork> {
    return this.http.post<LiveWork>(`${this.base}/live-work/${encodeURIComponent(id)}/stop`, {});
  }

  /** A picture pasted or dropped into a board text: stored in Alfred, its url used in the text (docs/board.md "Rich text"). */
  uploadImage(file: Blob): Observable<{ id: string; url: string }> {
    return this.http.post<{ id: string; url: string }>(`${this.base}/images`, file, { headers: { 'Content-Type': file.type || 'image/png' } });
  }

  /** A picture of a board text, as it was stored. */
  image(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/images/${encodeURIComponent(id)}`, { responseType: 'blob' });
  }

  /** The user's reaction on a comment, toggled; ✅ on Claude's plan is the go-ahead. */
  react(cardId: string, entryId: number, emoji: string): Observable<{ on: boolean }> {
    return this.http.post<{ on: boolean }>(`${this.base}/cards/${encodeURIComponent(cardId)}/comments/${entryId}/reactions`, { emoji });
  }

  /** The user edits their own comment; the earlier text is kept. */
  editComment(cardId: string, entryId: number, text: string): Observable<{ changed: boolean }> {
    return this.http.put<{ changed: boolean }>(`${this.base}/cards/${encodeURIComponent(cardId)}/comments/${entryId}`, { text });
  }

  /** Earlier texts of `comment:<id>` or `description:<card id>`, newest first. */
  versions(owner: string): Observable<readonly TextVersion[]> {
    return this.http.get<readonly TextVersion[]>(`${this.base}/versions`, { params: { owner } });
  }

  /** The chat that handles a cycle (null when none), and where the project's last chat ran. */
  cycleChat(cycleId: string, project: string): Observable<CycleChatInfo> {
    return this.http.get<CycleChatInfo>(`${this.base}/cycle-chat`, { params: { cycleId, project } });
  }

  /** ▶: queue a skill for the cycle's chat (docs/board.md "Run from the board"). */
  requestSkillRun(request: SkillRunRequest): Observable<SkillRun> {
    return this.http.post<SkillRun>(`${this.base}/skill-runs`, request);
  }

  skillRuns(project: string, cardNumber?: number | null, limit = 100): Observable<SkillRunsPage> {
    let params = new HttpParams().set('project', project).set('limit', limit);
    if (cardNumber != null) params = params.set('cardNumber', cardNumber);
    return this.http.get<SkillRunsPage>(`${this.base}/skill-runs`, { params });
  }

  stopSkillRun(id: string): Observable<SkillRun> {
    return this.http.post<SkillRun>(`${this.base}/skill-runs/${encodeURIComponent(id)}/stop`, {});
  }

  stopAllSkillRuns(project: string): Observable<{ stopped: number }> {
    return this.http.post<{ stopped: number }>(`${this.base}/skill-runs/stop-all`, { project });
  }

  agentStatus(project: string): Observable<AgentStatus | null> {
    return this.http.get<AgentStatus | null>(`${this.base}/agent-status`, { params: { project } });
  }

  agentAction(project: string, action: 'pause' | 'resume' | 'stop'): Observable<AgentStatus> {
    return this.http.post<AgentStatus>(`${this.base}/agent-status/${action}`, { project });
  }

  importBoard(project: string, file: Blob): Observable<{ cards: number; renumbered: { from: number; to: number }[] }> {
    return this.http.post<{ cards: number; renumbered: { from: number; to: number }[] }>(`${this.base}/import`, file,
      { params: { project }, headers: { 'Content-Type': 'application/x-ndjson' } });
  }
}

/** A history entry with its card, as /board/changes lists it. */
export interface ActivityEntryLike {
  readonly id: number;
  readonly cardId: string;
  readonly actor: 'USER' | 'CLAUDE';
  readonly kind: string;
  readonly text: string | null;
  readonly newValue: string | null;
  readonly project: string;
  readonly number: number;
  readonly title: string;
}
