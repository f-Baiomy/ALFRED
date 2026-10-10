import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ActivityPage, AgentStatus, BoardAccess, BoardFilters, BulkAction, CallBadge, CardDetail, CardEdit, CardStatus, CardsPage,
  ChecklistFile, ChecklistItem, CycleBrief, Mark, MentionRef, NewCard, Resolution, SpecFileInfo,
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

  update(id: string, edit: CardEdit): Observable<CardDetail> {
    return this.http.patch<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}`, edit);
  }

  move(id: string, status: CardStatus): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/move`, { status });
  }

  close(id: string, resolution: Resolution, reason?: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/close`, { resolution, reason });
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

  comment(id: string, text: string): Observable<unknown> {
    return this.http.post(`${this.base}/cards/${encodeURIComponent(id)}/comments`, { text });
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

  /** Takes Claude's proposed step as the user's own (moves or closes the card). */
  acceptProposal(id: string): Observable<CardDetail> {
    return this.http.post<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/proposal/accept`, {});
  }

  dismissProposal(id: string): Observable<CardDetail> {
    return this.http.delete<CardDetail>(`${this.base}/cards/${encodeURIComponent(id)}/proposal`);
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
