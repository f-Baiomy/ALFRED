import { Injectable, Injector, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, of, switchMap } from 'rxjs';
import {
  AuditLine, BoardSessionRow, CommandKind, ConnectStart, Devices, HelperCommand, HelperRow, Holder, Me, MySettings, PendingMessage, UserLine,
} from '../models/sessions.models';
import { AppConfigService } from './app-config.service';

/** HTTP for board sessions, the board lock and My settings (specs/031). The key travels in X-Alfred-Key (alfredKeyInterceptor). */
@Injectable({ providedIn: 'root' })
export class SessionsApiService {
  /** Resolved when a call is made: pages that only read the lock state (and their tests) need no HttpClient. */
  private readonly injector = inject(Injector);
  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/board`;
  }

  me(): Observable<Me> {
    return this.http.get<Me>(`${this.base}/me`);
  }

  pair(code: string, label: string): Observable<{ keyId: string; key: string; user: string; machine: string }> {
    return this.http.post<{ keyId: string; key: string; user: string; machine: string }>(`${this.base}/browsers/pair`, { code, label });
  }

  /** A "Connect this PC" file for this browser: its text, and what this browser collects its key with once the PC ran it. */
  connect(server: string, os: string, label: string): Observable<ConnectStart> {
    return this.http.post<ConnectStart>(`${this.base}/connect`, { server, os, label });
  }

  collect(connectId: string, collectSecret: string): Observable<{ keyId: string; key: string; user: string; machine: string }> {
    return this.http.post<{ keyId: string; key: string; user: string; machine: string }>(`${this.base}/connect/collect`, { connectId, collectSecret });
  }

  /** This user's own Azure DevOps token, held in Alfred's memory for them only (never stored, never sent back). */
  putMyToken(token: string): Observable<unknown> {
    return this.http.put(`${this.config.backendUrl}/teamboards/me/token`, { token });
  }

  /** Whether a token is in use for this user on the first tracker connection (their own, else the shared one). */
  myTokenLive(): Observable<boolean> {
    return this.http.get<{ id: string }[]>(`${this.config.backendUrl}/teamboards/connections`).pipe(
      switchMap((cs) => (cs.length
        ? this.http.get<{ live: boolean }>(`${this.config.backendUrl}/teamboards/connections/${encodeURIComponent(cs[0].id)}/token`).pipe(map((t) => !!t.live))
        : of(false))),
    );
  }

  /** The token to keep on one of this user's PCs ('' = remove it there): passed to that PC's helper once, in memory. */
  pcToken(helperKeyId: string, token: string): Observable<unknown> {
    return this.http.post(`${this.base}/me/pc-token`, { helperKeyId, token });
  }

  forgetMyToken(): Observable<unknown> {
    return this.http.delete(`${this.config.backendUrl}/teamboards/me/token`);
  }

  devices(): Observable<Devices> {
    return this.http.get<Devices>(`${this.base}/me/devices`);
  }

  revoke(keyId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/me/devices/${encodeURIComponent(keyId)}`);
  }

  myHelpers(): Observable<HelperRow[]> {
    return this.http.get<HelperRow[]>(`${this.base}/me/helpers`);
  }

  settings(): Observable<MySettings> {
    return this.http.get<MySettings>(`${this.base}/me/settings`);
  }

  saveSettings(s: MySettings): Observable<MySettings> {
    return this.http.put<MySettings>(`${this.base}/me/settings`, s);
  }

  holders(project: string): Observable<Holder[]> {
    return this.http.get<Holder[]>(`${this.base}/holders`, { params: new HttpParams().set('project', project) });
  }

  holder(boardId: string): Observable<Holder[]> {
    return this.http.get<Holder[]>(`${this.base}/holders`, { params: new HttpParams().set('boardId', boardId) });
  }

  take(boardId: string, project: string, sessionId: string | null): Observable<Holder> {
    return this.http.post<Holder>(`${this.base}/holders/take`, { boardId, project, sessionId });
  }

  release(boardId: string): Observable<Holder> {
    return this.http.post<Holder>(`${this.base}/holders/release`, { boardId });
  }

  ask(boardId: string, note: string): Observable<Holder> {
    return this.http.post<Holder>(`${this.base}/holders/request`, { boardId, note });
  }

  answer(boardId: string, answer: 'HAND_OVER' | 'RELEASE' | 'KEEP'): Observable<Holder> {
    return this.http.post<Holder>(`${this.base}/holders/answer`, { boardId, answer });
  }

  commenters(boardId: string, commenters: readonly string[]): Observable<Holder> {
    return this.http.put<Holder>(`${this.base}/holders/commenters`, { boardId, commenters });
  }

  submitPending(boardId: string, project: string, scope: string, text: string): Observable<PendingMessage> {
    return this.http.post<PendingMessage>(`${this.base}/holders/pending`, { boardId, project, scope, text });
  }

  pending(boardId: string): Observable<PendingMessage[]> {
    return this.http.get<PendingMessage[]>(`${this.base}/holders/pending`, { params: new HttpParams().set('boardId', boardId) });
  }

  resolvePending(id: number, letClaudeAnswer: boolean): Observable<{ message: PendingMessage; post: string | null }> {
    return this.http.post<{ message: PendingMessage; post: string | null }>(`${this.base}/holders/pending/${id}`, { letClaudeAnswer });
  }

  forceRelease(boardId: string): Observable<Holder> {
    return this.http.post<Holder>(`${this.base}/holders/force-release`, { boardId });
  }

  sessions(project: string, boardId = ''): Observable<BoardSessionRow[]> {
    return this.http.get<BoardSessionRow[]>(`${this.base}/sessions`, { params: new HttpParams().set('project', project).set('boardId', boardId) });
  }

  command(kind: CommandKind, o: { helperKeyId?: string | null; boardId?: string | null; project?: string; sessionId?: string | null; args?: object }): Observable<HelperCommand> {
    return this.http.post<HelperCommand>(`${this.base}/helper-commands`, {
      kind, helperKeyId: o.helperKeyId ?? null, boardId: o.boardId ?? null, project: o.project ?? '', sessionId: o.sessionId ?? null,
      args: o.args ? JSON.stringify(o.args) : null,
    });
  }

  commands(): Observable<HelperCommand[]> {
    return this.http.get<HelperCommand[]>(`${this.base}/helper-commands`);
  }

  cancelCommand(id: string): Observable<HelperCommand> {
    return this.http.post<HelperCommand>(`${this.base}/helper-commands/${encodeURIComponent(id)}/cancel`, {});
  }

  audit(boardId: string, limit = 200): Observable<AuditLine[]> {
    return this.http.get<AuditLine[]>(`${this.base}/audit`, { params: new HttpParams().set('boardId', boardId).set('limit', limit) });
  }

  users(): Observable<UserLine[]> {
    return this.http.get<UserLine[]>(`${this.base}/users`);
  }

  userHelpers(user: string): Observable<HelperRow[]> {
    return this.http.get<HelperRow[]>(`${this.base}/users/${encodeURIComponent(user)}/helpers`);
  }

  adminRevoke(keyId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/users/keys/${encodeURIComponent(keyId)}`);
  }
}
