import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  DeleteImpact,
  FieldStats,
  FieldValues,
  GroupNode,
  Histogram,
  InputKind,
  LineStructures,
  SessionView,
  WatchedFile,
  WatchFolders,
  WatchOptions,
  LogComment,
  LogInput,
  LogLine,
  LogLineSummary,
  LogPage,
  LogQuery,
  LogStructure,
  Minimap,
  Pattern,
  Pill,
  PrivacyMode,
  RawMode,
  SavedView,
  SavedViewState,
  ServerFile,
  SourceView,
  StructurePreview,
  UploadTicket,
} from '../models/logs.model';

/** Every backend-logs endpoint (specs/004-logs-explorer/contracts/rest-api.md). */
@Injectable({ providedIn: 'root' })
export class LogsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/logs`;
  }

  private src(id: string): string {
    return `${this.base}/sources/${encodeURIComponent(id)}`;
  }

  // ---- sources & structure
  sources(): Observable<SourceView[]> {
    return this.http.get<SourceView[]>(`${this.base}/sources`);
  }

  source(id: string): Observable<SourceView> {
    return this.http.get<SourceView>(this.src(id));
  }

  preview(sampleLines: readonly string[] | null, serverPath: string | null, watch?: { folder: string; path: string }): Observable<StructurePreview> {
    return this.http.post<StructurePreview>(`${this.base}/structure/preview`, {
      sampleLines,
      serverPath,
      watchFolder: watch?.folder ?? null,
      watchPath: watch?.path ?? null,
    });
  }

  // ---- watched folders (settings.properties logs_watch_dirs) - listened on live
  watchFolders(): Observable<WatchFolders> {
    return this.http.get<WatchFolders>(`${this.base}/watch-folders`);
  }

  watchFiles(folder: string, pattern: string, subfolders: boolean): Observable<WatchedFile[]> {
    return this.http.get<WatchedFile[]>(`${this.base}/watch-folders/${encodeURIComponent(folder)}/files`, {
      params: { pattern, subfolders: String(subfolders) },
    });
  }

  // ---- session recordings
  sessions(id: string): Observable<SessionView[]> {
    return this.http.get<SessionView[]>(`${this.src(id)}/sessions`);
  }

  session(id: string, sessionId: string): Observable<SessionView> {
    return this.http.get<SessionView>(`${this.src(id)}/sessions/${encodeURIComponent(sessionId)}`);
  }

  startSession(id: string, body: { name: string; kind: 'WINDOW' | 'ID'; pills?: readonly Pill[]; idField?: string | null; idValue?: string | null }): Observable<SessionView> {
    return this.http.post<SessionView>(`${this.src(id)}/sessions`, body);
  }

  markSession(id: string, sessionId: string, text: string): Observable<SessionView> {
    return this.http.post<SessionView>(`${this.src(id)}/sessions/${encodeURIComponent(sessionId)}/markers`, { text });
  }

  stopSession(id: string, sessionId: string): Observable<SessionView> {
    return this.http.post<SessionView>(`${this.src(id)}/sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  updateSession(id: string, sessionId: string, name: string, notes: string): Observable<SessionView> {
    return this.http.patch<SessionView>(`${this.src(id)}/sessions/${encodeURIComponent(sessionId)}`, { name, notes });
  }

  deleteSession(id: string, sessionId: string): Observable<void> {
    return this.http.delete<void>(`${this.src(id)}/sessions/${encodeURIComponent(sessionId)}`);
  }

  createSource(name: string, rawMode: RawMode, privacyMode: PrivacyMode, structure: LogStructure): Observable<SourceView> {
    return this.http.post<SourceView>(`${this.base}/sources`, { name, rawMode, privacyMode, structure });
  }

  updateSource(id: string, patch: { name?: string; retentionMaxBytes?: number }): Observable<SourceView> {
    return this.http.patch<SourceView>(this.src(id), patch);
  }

  deleteImpact(id: string): Observable<DeleteImpact> {
    return this.http.get<DeleteImpact>(`${this.src(id)}/delete-impact`);
  }

  deleteSource(id: string): Observable<void> {
    return this.http.delete<void>(this.src(id));
  }

  structure(id: string): Observable<LogStructure> {
    return this.http.get<LogStructure>(`${this.src(id)}/structure`);
  }

  saveStructure(id: string, structure: LogStructure): Observable<LogStructure> {
    return this.http.put<LogStructure>(`${this.src(id)}/structure`, structure);
  }

  // ---- inputs
  serverFiles(dir: string): Observable<ServerFile[]> {
    return this.http.get<ServerFile[]>(`${this.base}/server-files`, { params: { dir } });
  }

  createUpload(fileName: string, size: number): Observable<UploadTicket> {
    return this.http.post<UploadTicket>(`${this.base}/uploads`, { fileName, size });
  }

  uploadStatus(uploadId: string): Observable<UploadTicket> {
    return this.http.get<UploadTicket>(`${this.base}/uploads/${encodeURIComponent(uploadId)}`);
  }

  uploadChunk(uploadId: string, index: number, data: Blob): Observable<UploadTicket> {
    return this.http.put<UploadTicket>(`${this.base}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, data, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  addInput(sourceId: string, body: { kind: InputKind; ref: string; fingerprint?: string | null; fromStart?: boolean; confirmDuplicate?: boolean; watch?: WatchOptions }): Observable<LogInput> {
    return this.http.post<LogInput>(`${this.src(sourceId)}/inputs`, body);
  }

  inputAction(sourceId: string, inputId: string, action: 'pause' | 'resume'): Observable<LogInput> {
    return this.http.post<LogInput>(`${this.src(sourceId)}/inputs/${encodeURIComponent(inputId)}/${action}`, {});
  }

  deleteInput(sourceId: string, inputId: string): Observable<void> {
    return this.http.delete<void>(`${this.src(sourceId)}/inputs/${encodeURIComponent(inputId)}`);
  }

  // ---- line structures (each line may have its own structure)
  /** Structures with "seen in X %" per field; with a query, also how many of each match it. */
  structures(id: string, query?: LogQuery): Observable<LineStructures> {
    return query
      ? this.http.post<LineStructures>(`${this.src(id)}/structures`, query)
      : this.http.get<LineStructures>(`${this.src(id)}/structures`);
  }

  /** Name and summary template of one structure; blank resets to the automatic name / the source template. */
  updateLineStructure(id: string, structureId: number, name: string, template: string): Observable<void> {
    return this.http.patch<void>(`${this.src(id)}/structures/${structureId}`, { name, template });
  }

  /** Moves one structure's lines into a new source (raw lines copied into ALFRED only). */
  moveLineStructure(id: string, structureId: number, name: string): Observable<SourceView> {
    return this.http.post<SourceView>(`${this.src(id)}/structures/${structureId}/move`, { name });
  }

  // ---- queries
  lines(id: string, query: LogQuery): Observable<LogPage> {
    return this.http.post<LogPage>(`${this.src(id)}/lines`, query);
  }

  line(id: string, lineId: string): Observable<LogLine> {
    return this.http.get<LogLine>(`${this.src(id)}/lines/${encodeURIComponent(lineId)}`);
  }

  context(id: string, lineId: string, before = 20, after = 20): Observable<LogLineSummary[]> {
    return this.http.get<LogLineSummary[]>(`${this.src(id)}/lines/${encodeURIComponent(lineId)}/context`, {
      params: { before, after },
    });
  }

  histogram(id: string, query: LogQuery, buckets = 60): Observable<Histogram> {
    return this.http.post<Histogram>(`${this.src(id)}/histogram`, query, { params: { buckets } });
  }

  fieldValues(id: string, query: LogQuery): Observable<FieldValues> {
    return this.http.post<FieldValues>(`${this.src(id)}/fields/values`, query);
  }

  fieldStats(id: string, label: string, query: LogQuery): Observable<FieldStats> {
    return this.http.post<FieldStats>(`${this.src(id)}/fields/${encodeURIComponent(label)}/stats`, query);
  }

  minimap(id: string, query: LogQuery, condition: readonly Pill[]): Observable<Minimap> {
    return this.http.post<Minimap>(`${this.src(id)}/minimap`, { query, condition });
  }

  trace(id: string, lineId: string): Observable<LogLineSummary[]> {
    return this.http.get<LogLineSummary[]>(`${this.src(id)}/trace`, { params: { lineId } });
  }

  groups(id: string, query: LogQuery, parentPath: string, offset = 0, limit = 100): Observable<GroupNode[]> {
    return this.http.post<GroupNode[]>(`${this.src(id)}/groups`, { query, parentPath, offset, limit });
  }

  /** A group node's own lines (skipped=false) or level-skipping lines (skipped=true), keyset-paged. */
  nodeLines(id: string, query: LogQuery, path: string, skipped: boolean): Observable<LogPage> {
    return this.http.post<LogPage>(`${this.src(id)}/groups/lines`, { query, path, skipped });
  }

  invalidValues(id: string, label: string): Observable<LogLineSummary[]> {
    return this.http.get<LogLineSummary[]>(`${this.src(id)}/fields/${encodeURIComponent(label)}/invalid`);
  }

  bucket(id: string, query: LogQuery): Observable<LogPage> {
    return this.http.post<LogPage>(`${this.src(id)}/groups/bucket`, query);
  }

  patterns(id: string, query: LogQuery): Observable<Pattern[]> {
    return this.http.post<Pattern[]>(`${this.src(id)}/patterns`, query);
  }

  // ---- annotations
  comments(id: string, lineId: string): Observable<LogComment[]> {
    return this.http.get<LogComment[]>(`${this.src(id)}/lines/${encodeURIComponent(lineId)}/comments`);
  }

  addComment(id: string, lineId: string, path: string, text: string, authorProfileId: string | null): Observable<LogComment> {
    return this.http.post<LogComment>(`${this.src(id)}/lines/${encodeURIComponent(lineId)}/comments`, { path, text, authorProfileId });
  }

  deleteComment(id: string, commentId: string): Observable<void> {
    return this.http.delete<void>(`${this.src(id)}/comments/${encodeURIComponent(commentId)}`);
  }

  commentAll(id: string, lineIds: readonly string[] | null, allMatching: LogQuery | null, text: string, authorProfileId: string | null): Observable<{ commented: number }> {
    return this.http.post<{ commented: number }>(`${this.src(id)}/selection/comment`, { lineIds, allMatching, text, authorProfileId });
  }

  pin(id: string, lineIds: readonly string[] | null, allMatching: LogQuery | null): Observable<{ pinned: number }> {
    return this.http.post<{ pinned: number }>(`${this.src(id)}/selection/pin`, { lineIds, allMatching });
  }

  views(id: string): Observable<SavedView[]> {
    return this.http.get<SavedView[]>(`${this.src(id)}/views`);
  }

  saveView(id: string, name: string, state: SavedViewState): Observable<SavedView> {
    return this.http.post<SavedView>(`${this.src(id)}/views`, { name, state });
  }

  deleteView(id: string, viewId: string): Observable<void> {
    return this.http.delete<void>(`${this.src(id)}/views/${encodeURIComponent(viewId)}`);
  }
}
