import { ChatWatch } from '../models/chat.models';
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  AskAgain, ChatMessage, ChatPage, ChatSearchFilter, ChatSearchHit, ChatSettings, ChatSharedGroup, ChatSummary, NewChatMessage,
  ProposalOutcome, TerminalItem,
} from '../models/chat.models';
import { AppConfigService } from './app-config.service';

/** HTTP for /board/chats (specs/022 contracts/rest-api.md). The user's side only - Claude writes through the MCP tools. */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/board/chats`;
  }

  private scoped(scope: string): string {
    return `${this.base}/${encodeURIComponent(scope)}`;
  }

  private message(id: number): string {
    return `${this.base}/messages/${id}`;
  }

  // ------------------------------------------------------------------------------------------------------------ reads

  summaries(project: string): Observable<ChatSummary[]> {
    return this.http.get<ChatSummary[]>(this.base, { params: { project } });
  }

  /** The board export's chat records, page by page (specs/022 T052) - written into the .json as they come. */
  exportPage(project: string, cycleId: string | null, after: number): Observable<{ lines: unknown[]; next: number; more: boolean }> {
    const params: Record<string, string> = { project, after: String(after), limit: '200' };
    if (cycleId) params['cycleId'] = cycleId;
    return this.http.get<{ lines: unknown[]; next: number; more: boolean }>(`${this.base}/export`, { params });
  }

  messages(project: string, scope: string, before: number | null = null, limit = 50): Observable<ChatPage> {
    let params = new HttpParams().set('project', project).set('limit', limit);
    if (before != null) params = params.set('before', before);
    return this.http.get<ChatPage>(`${this.scoped(scope)}/messages`, { params });
  }

  search(project: string, scope: string, q: string, filter: ChatSearchFilter = 'all'): Observable<{ hits: ChatSearchHit[] }> {
    return this.http.get<{ hits: ChatSearchHit[] }>(`${this.scoped(scope)}/search`, { params: { project, q, filter } });
  }

  /** "While you were away" (FR-023): null when nothing changed (204). */
  digest(project: string, scope: string, since: number): Observable<{ lines: string[]; since: string } | null> {
    return this.http.get<{ lines: string[]; since: string } | null>(`${this.scoped(scope)}/digest`, { params: { project, since: String(since) } });
  }

  shared(project: string, scope: string): Observable<{ groups: ChatSharedGroup[] }> {
    return this.http.get<{ groups: ChatSharedGroup[] }>(`${this.scoped(scope)}/shared`, { params: { project } });
  }

  terminal(project: string, scope: string): Observable<TerminalItem[]> {
    return this.http.get<TerminalItem[]>(`${this.scoped(scope)}/terminal`, { params: { project } });
  }

  settings(project: string, scope: string): Observable<ChatSettings> {
    return this.http.get<ChatSettings>(`${this.scoped(scope)}/settings`, { params: { project } });
  }

  // ----------------------------------------------------------------------------------------------------------- writes

  post(project: string, scope: string, body: NewChatMessage): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.scoped(scope)}/messages`, body, { params: { project } });
  }

  edit(id: number, text: string): Observable<ChatMessage> {
    return this.http.patch<ChatMessage>(this.message(id), { text });
  }

  cancel(id: number): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/cancel`, {});
  }

  urgent(id: number): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/urgent`, {});
  }

  decision(id: number, on: boolean): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/decision`, { on });
  }

  /** The user's answers to Claude's questions on one answer, by question header (FR-025). */
  answers(id: number, answers: Readonly<Record<string, string>>): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/answers`, { answers });
  }

  react(id: number, emoji: string): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/react`, { emoji });
  }

  again(id: number, ask: AskAgain): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.message(id)}/again`, ask);
  }

  proposals(id: number, accept: readonly string[], decline: readonly string[]): Observable<ProposalOutcome> {
    return this.http.post<ProposalOutcome>(`${this.message(id)}/proposals`, { accept, decline });
  }

  /** Each open proposal checked against the board now: null = can be accepted, else why not (FR-026). */
  checkProposals(id: number): Observable<{ checks: Readonly<Record<string, string | null>> }> {
    return this.http.get<{ checks: Readonly<Record<string, string | null>> }>(`${this.message(id)}/proposals`);
  }

  consent(id: number, yes: boolean): Observable<void> {
    return this.http.post<void>(`${this.message(id)}/consent`, { yes });
  }

  undo(token: string): Observable<void> {
    return this.http.post<void>(`${this.base}/undo/${encodeURIComponent(token)}`, {});
  }

  /** One applied proposal of a message put back (no time limit; refused when the board changed since). */
  undoProposal(messageId: number, proposalId: string): Observable<void> {
    return this.http.post<void>(`${this.message(messageId)}/proposals/${encodeURIComponent(proposalId)}/undo`, {});
  }

  undoRecord(id: number): Observable<void> {
    return this.http.post<void>(`${this.base}/records/${id}/undo`, {});
  }

  undoTerminal(id: number): Observable<void> {
    return this.http.post<void>(`${this.base}/terminal/${id}/undo`, {});
  }

  compact(project: string, scope: string): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.scoped(scope)}/compact`, {}, { params: { project } });
  }

  putSettings(project: string, scope: string, settings: ChatSettings): Observable<ChatSettings> {
    return this.http.put<ChatSettings>(`${this.scoped(scope)}/settings`, settings, { params: { project } });
  }

  watches(project: string, scope: string): Observable<ChatWatch[]> {
    return this.http.get<ChatWatch[]>(`${this.scoped(scope)}/watches`, { params: { project } });
  }

  cancelWatch(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/watches/${id}`);
  }

  refresh(project: string, scope: string): Observable<void> {
    return this.http.post<void>(`${this.scoped(scope)}/refresh`, {}, { params: { project } });
  }
}
