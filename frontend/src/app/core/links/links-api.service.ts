import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from '../services/app-config.service';
import {
  AlfredSelf, EnvAssigned, EnvBoard, EnvColumn, EnvCycle, EnvDef, EnvMark, EnvRetest, EnvStep, LinkInfo, LinkRequest, Offer, Pairing,
  Presence, ReadEntry, RequestState, SendRequest, Stream, StreamIn, StreamKind, StreamMode,
} from './links.models';

/** Found on the LAN by the native supervisor (D33): name, address and version only. */
export interface Discovered {
  readonly alfredId: string;
  readonly name: string;
  readonly address: string;
  readonly version: string;
  readonly seenAt: string | null;
  /** Set when this Alfred is already linked with it. */
  readonly linkedSlug: string | null;
}

export interface Discovery {
  readonly available: boolean;
  readonly why: string | null;
  readonly announcing: boolean;
  readonly found: Discovered[];
}

/** HTTP for links, streams, requests, the read log, presence and environments (specs/035, /links). */
@Injectable({ providedIn: 'root' })
export class LinksApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/links`;
  }

  // ------------------------------------------------------------------------------------------------- this Alfred
  self(): Observable<AlfredSelf> {
    return this.http.get<AlfredSelf>(`${this.base}/self`);
  }

  updateSelf(patch: { name?: string; announce?: boolean }): Observable<AlfredSelf> {
    return this.http.patch<AlfredSelf>(`${this.base}/self`, patch);
  }

  discovered(): Observable<Discovery> {
    return this.http.get<Discovery>(`${this.base}/discovered`);
  }

  // ------------------------------------------------------------------------------------------------------- links
  links(): Observable<LinkInfo[]> {
    return this.http.get<LinkInfo[]>(this.base);
  }

  rename(id: string, name: string): Observable<LinkInfo> {
    return this.http.patch<LinkInfo>(`${this.base}/${encodeURIComponent(id)}`, { name });
  }

  readdress(id: string, address: string): Observable<LinkInfo> {
    return this.http.patch<LinkInfo>(`${this.base}/${encodeURIComponent(id)}/address`, { address });
  }

  unlink(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(id)}`);
  }

  // ----------------------------------------------------------------------------------------------------- pairing
  pair(address: string, name: string): Observable<Pairing> {
    return this.http.post<Pairing>(`${this.base}/pair`, { address, name });
  }

  pairings(): Observable<Pairing[]> {
    return this.http.get<Pairing[]>(`${this.base}/pairings`);
  }

  cancelPairing(id: string): Observable<void> {
    return this.http.post<void>(`${this.base}/pairings/${encodeURIComponent(id)}/cancel`, {});
  }

  dismissPairing(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/pairings/${encodeURIComponent(id)}`);
  }

  offers(): Observable<Offer[]> {
    return this.http.get<Offer[]>(`${this.base}/pair/offers`);
  }

  acceptOffer(id: string, name: string): Observable<LinkInfo> {
    return this.http.post<LinkInfo>(`${this.base}/pair/offers/${encodeURIComponent(id)}/accept`, { name });
  }

  rejectOffer(id: string): Observable<void> {
    return this.http.post<void>(`${this.base}/pair/offers/${encodeURIComponent(id)}/reject`, {});
  }

  // ----------------------------------------------------------------------------------------------------- streams
  streams(filter: { mine?: boolean; linkId?: string; kind?: StreamKind; target?: string; ended?: boolean } = {}): Observable<Stream[]> {
    let params = new HttpParams();
    if (filter.mine !== undefined) params = params.set('mine', filter.mine);
    if (filter.linkId) params = params.set('linkId', filter.linkId);
    if (filter.kind) params = params.set('kind', filter.kind);
    if (filter.target) params = params.set('target', filter.target);
    if (filter.ended) params = params.set('ended', true);
    return this.http.get<Stream[]>(`${this.base}/streams`, { params });
  }

  startStream(s: StreamIn): Observable<Stream> {
    return this.http.post<Stream>(`${this.base}/streams`, s);
  }

  updateStream(id: string, patch: { mode?: StreamMode; autoAccept?: boolean; passOn?: boolean; passMode?: StreamMode; unmasked?: boolean }):
    Observable<Stream> {
    return this.http.patch<Stream>(`${this.base}/streams/${encodeURIComponent(id)}`, patch);
  }

  stopStream(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/streams/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------------------------------------------- requests
  requests(filter: { incoming?: boolean; state?: RequestState; linkId?: string; limit?: number } = {}): Observable<LinkRequest[]> {
    let params = new HttpParams();
    if (filter.incoming !== undefined) params = params.set('incoming', filter.incoming);
    if (filter.state) params = params.set('state', filter.state);
    if (filter.linkId) params = params.set('linkId', filter.linkId);
    if (filter.limit) params = params.set('limit', filter.limit);
    return this.http.get<LinkRequest[]>(`${this.base}/requests`, { params });
  }

  waiting(): Observable<{ waiting: number }> {
    return this.http.get<{ waiting: number }>(`${this.base}/requests/waiting`);
  }

  send(r: SendRequest): Observable<LinkRequest> {
    return this.http.post<LinkRequest>(`${this.base}/requests`, r);
  }

  accept(id: string): Observable<LinkRequest> {
    return this.http.post<LinkRequest>(`${this.base}/requests/${encodeURIComponent(id)}/accept`, {});
  }

  reject(id: string, note: string | null): Observable<LinkRequest> {
    return this.http.post<LinkRequest>(`${this.base}/requests/${encodeURIComponent(id)}/reject`, { note });
  }

  undo(id: string): Observable<LinkRequest> {
    return this.http.post<LinkRequest>(`${this.base}/requests/${encodeURIComponent(id)}/undo`, {});
  }

  withdraw(id: string): Observable<LinkRequest> {
    return this.http.post<LinkRequest>(`${this.base}/requests/${encodeURIComponent(id)}/withdraw`, {});
  }

  // ------------------------------------------------------------------------------------------ read log, presence
  reads(linkId: string | null, days = 7): Observable<ReadEntry[]> {
    let params = new HttpParams().set('days', days);
    if (linkId) params = params.set('linkId', linkId);
    return this.http.get<ReadEntry[]>(`${this.base}/reads`, { params });
  }

  presence(): Observable<Presence[]> {
    return this.http.get<Presence[]>(`${this.base}/presence`);
  }

  // ------------------------------------------------------------------------------------------------ environments
  envBoard(boardId: string): Observable<EnvBoard> {
    return this.http.get<EnvBoard>(`${this.base}/envs/${encodeURIComponent(boardId)}`);
  }

  envDefs(boardId: string): Observable<EnvDef[]> {
    return this.http.get<EnvDef[]>(`${this.base}/envs/${encodeURIComponent(boardId)}/defs`);
  }

  setEnvs(boardId: string, boardName: string, project: string, envs: { name: string; linkId: string | null; required: boolean }[]):
    Observable<EnvDef[]> {
    return this.http.put<EnvDef[]>(`${this.base}/envs/${encodeURIComponent(boardId)}`, { boardName, project, envs });
  }

  envCycles(boardId: string): Observable<EnvCycle[]> {
    return this.http.get<EnvCycle[]>(`${this.base}/envs/${encodeURIComponent(boardId)}/cycles`);
  }

  tagCycle(boardId: string, cycleRef: string, env: string, retestFor: number[], name: string): Observable<EnvCycle> {
    return this.http.post<EnvCycle>(`${this.base}/envs/${encodeURIComponent(boardId)}/cycles`, { cycleRef, env, retestFor, name });
  }

  untagCycle(boardId: string, cycleRef: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/envs/${encodeURIComponent(boardId)}/cycles`, { params: { ref: cycleRef } });
  }

  assignments(): Observable<EnvAssigned[]> {
    return this.http.get<EnvAssigned[]>(`${this.base}/env/assignments`);
  }

  myColumn(hostSlug: string, boardId: string): Observable<EnvColumn> {
    return this.http.get<EnvColumn>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}`);
  }

  envMark(hostSlug: string, boardId: string, fileName: string, itemKey: string, mark: string, evidence = ''): Observable<EnvMark> {
    return this.http.put<EnvMark>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/marks`,
      { fileName, itemKey, mark, evidence });
  }

  clearEnvMark(hostSlug: string, boardId: string, fileName: string, itemKey: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/marks`,
      { params: { fileName, itemKey } });
  }

  envStep(hostSlug: string, boardId: string, stepKey: string, state: 'SEEN' | 'FAILED', note = ''): Observable<EnvStep> {
    return this.http.put<EnvStep>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/steps`, { stepKey, state, note });
  }

  clearEnvStep(hostSlug: string, boardId: string, stepKey: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/steps`, { params: { stepKey } });
  }

  envRecord(hostSlug: string, boardId: string, name: string | null, retestFor: number[]): Observable<EnvCycle> {
    return this.http.post<EnvCycle>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/record`, { name, retestFor });
  }

  envRetest(hostSlug: string, boardId: string, cards: number[], cycleId: string | null): Observable<EnvRetest[]> {
    return this.http.post<EnvRetest[]>(`${this.base}/env/${encodeURIComponent(hostSlug)}/${encodeURIComponent(boardId)}/retest`, { cards, cycleId });
  }
}
