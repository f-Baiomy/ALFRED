import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { LogStructureEditorComponent } from '../../components/logs/log-structure-editor.component';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { InputKind, InputStatus, LogInput, LogStructure, PrivacyMode, RawMode, ServerFile, SourceView, UploadTicket } from '../../core/models/logs.model';

const HEAD_BYTES = 1 << 20;
const PREVIEW_BYTES = 4 << 20;
const PREVIEW_LINES = 1000;
/** An upload in progress, remembered so a page refresh can resume it (FR-003). */
const PENDING_KEY = 'alfred.logs.pendingUpload';

interface PendingUpload {
  readonly uploadId: string;
  readonly name: string;
  readonly size: number;
  readonly sourceId: string;
  readonly inputId: string;
}

function readPending(): PendingUpload | null {
  try {
    const v = localStorage.getItem(PENDING_KEY);
    return v ? (JSON.parse(v) as PendingUpload) : null;
  } catch {
    return null;
  }
}

function writePending(p: PendingUpload | null): void {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Without storage an interrupted upload simply starts over.
  }
}

type Step = 1 | 2 | 3;

interface Kind {
  readonly id: InputKind;
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  readonly available: boolean;
}

/** "<sha256 of the first MB>:<size>" - the same fingerprint the backend computes for server files. */
async function fingerprint(file: File): Promise<string> {
  const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}:${file.size}`;
}

/** New source wizard: Input → Structure → Load (mock.html `renderWizard()`, `wizInput()`, `wizLoad()`). */
@Component({
  selector: 'app-log-source-wizard',
  standalone: true,
  imports: [FormsModule, RouterLink, DecimalPipe, LogStructureEditorComponent, ConfirmDialogComponent],
  templateUrl: './log-source-wizard.component.html',
})
export class LogSourceWizardComponent implements OnInit {
  private readonly api = inject(LogsApiService);
  private readonly socket = inject(LogsSocketService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirm = inject(ConfirmDialogService);
  /** Set when adding an input to an existing source (/logs/new?source=<id>): no structure step. */
  private readonly existingId = inject(ActivatedRoute).snapshot.queryParamMap.get('source');

  readonly kinds: readonly Kind[] = [
    { id: 'UPLOAD', icon: '⇪', title: 'Upload file', text: 'From your machine. Sent in chunks, works for 10 GB+ through the tunnel.', available: true },
    { id: 'SERVER_FILE', icon: '⧉', title: 'File on server', text: 'Pick from the mounted logs folder. No upload.', available: true },
    { id: 'FOLLOW', icon: '↻', title: 'Follow a file', text: 'Live tail of a growing file. Survives rotation and restarts.', available: true },
    { id: 'PUSH', icon: '⇢', title: 'HTTP push', text: 'Another system posts lines to Alfred. Waiting on how Alfred keeps its secret.', available: false },
    { id: 'OPENSEARCH', icon: '☁', title: 'OpenSearch', text: 'Import, follow or browse in place. Waiting on how Alfred keeps credentials.', available: false },
  ];

  readonly step = signal<Step>(1);
  readonly kind = signal<InputKind>('UPLOAD');
  readonly name = signal('');
  readonly rawMode = signal<RawMode>('COPY');
  readonly privacy = signal<PrivacyMode>('SHOW');
  readonly file = signal<File | null>(null);
  readonly dir = signal('');
  readonly serverFiles = signal<ServerFile[]>([]);
  readonly serverPath = signal('');
  readonly fromStart = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly structure = signal<LogStructure | null>(null);
  readonly sample = signal<Record<string, unknown>>({});
  readonly matching = signal<{ id: string; name: string } | null>(null);
  /** Line structures in the sample: lines may each have their own; all load into this one source. */
  readonly sampleShape = signal<{ structures: number; lines: number } | null>(null);
  readonly sourceId = signal<string | null>(null);
  readonly inputId = signal<string | null>(null);
  readonly uploadPct = signal(0);
  readonly progress = signal<{ status: InputStatus; lines: number; bytes: number; total: number; unparsed: number; reason: string | null; newField: string | null } | null>(null);

  readonly existing = signal<SourceView | null>(null);
  readonly pending = signal<PendingUpload | null>(readPending());
  readonly selectedKind = computed(() => this.kinds.find((k) => k.id === this.kind())!);
  readonly ref = computed(() => (this.kind() === 'UPLOAD' ? this.file()?.name ?? '' : this.serverPath()));
  readonly loadPct = computed(() => {
    const p = this.progress();
    return p && p.total > 0 ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : p?.status === 'DONE' ? 100 : 0;
  });

  ngOnInit(): void {
    this.listDir('');
    if (this.existingId) {
      this.api.source(this.existingId).subscribe({
        next: (v) => {
          this.existing.set(v);
          this.name.set(v.source.name);
          this.rawMode.set(v.source.rawMode);
          this.privacy.set(v.source.privacyMode);
        },
        error: () => this.error.set('That source does not exist (any more).'),
      });
    }
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.type === 'input-progress' && e.inputId === this.inputId()) {
        this.progress.set({ status: e.status, lines: e.lines, bytes: e.bytes, total: e.totalBytes, unparsed: e.unparsed, reason: e.reason, newField: e.newField ?? this.progress()?.newField ?? null });
      }
    });
  }

  pickKind(k: Kind): void {
    if (!k.available) return;
    this.kind.set(k.id);
    this.error.set('');
  }

  listDir(dir: string): void {
    this.dir.set(dir);
    this.api.serverFiles(dir).subscribe({ next: (f) => this.serverFiles.set(f), error: () => this.serverFiles.set([]) });
  }

  pickServer(f: ServerFile): void {
    if (f.directory) this.listDir(f.path);
    else {
      this.serverPath.set(f.path);
      if (!this.name()) this.name.set(f.name.replace(/\.(ndjson|log|json|txt)(\.\d+)?$/i, ''));
    }
  }

  onFile(ev: Event): void {
    const f = (ev.target as HTMLInputElement).files?.[0] ?? null;
    this.file.set(f);
    if (f && !this.name()) this.name.set(f.name.replace(/\.(ndjson|log|json|txt)$/i, ''));
  }

  private failed(e: unknown, fallback: string): void {
    this.error.set((e as { error?: { error?: string } })?.error?.error || fallback);
    this.busy.set(false);
  }

  async next(): Promise<void> {
    this.error.set('');
    if (!this.name().trim()) return this.error.set('Give the source a name');
    if (!this.ref()) return this.error.set(this.kind() === 'UPLOAD' ? 'Choose a file' : 'Pick a file from the server folder');
    if (this.existing()) return this.load();
    this.busy.set(true);
    try {
      let lines: string[] | null = null;
      if (this.kind() === 'UPLOAD') {
        const text = await this.file()!.slice(0, PREVIEW_BYTES).text();
        // The last line of the slice may be cut in half; it is dropped rather than misread.
        lines = text.split('\n').slice(0, -1).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, PREVIEW_LINES);
      }
      const preview = await firstValueFrom(this.api.preview(lines, lines ? null : this.serverPath()));
      this.structure.set(preview.structure);
      this.sampleShape.set({ structures: preview.structures, lines: preview.sampledLines });
      this.matching.set(preview.matchingSourceId ? { id: preview.matchingSourceId, name: preview.matchingSourceName ?? '' } : null);
      if (lines?.length) {
        try {
          this.sample.set(flat(JSON.parse(lines.find((l) => l.startsWith('{')) ?? '{}')));
        } catch {
          this.sample.set({});
        }
      }
      this.step.set(2);
      this.busy.set(false);
    } catch (e) {
      this.failed(e, 'Could not read that file');
    }
  }

  async load(): Promise<void> {
    const s = this.structure();
    const existing = this.existing();
    if (!s && !existing) return;
    this.error.set('');
    if (this.privacy() === 'REDACT_AT_LOAD' && this.rawMode() !== 'COPY') {
      return this.error.set('Redact at load needs raw lines copied into Alfred (step 1).');
    }
    this.busy.set(true);
    try {
      const sourceId = existing ? existing.source.id : (await firstValueFrom(this.api.createSource(this.name().trim(), this.rawMode(), this.privacy(), s!))).source.id;
      this.sourceId.set(sourceId);
      this.step.set(3);
      if (this.kind() === 'UPLOAD') await this.upload(sourceId);
      else {
        const input = await this.addInput(sourceId, { kind: this.kind(), ref: this.serverPath(), fromStart: this.fromStart() });
        if (!input) return;
        this.inputId.set(input.id);
        this.progress.set({ status: input.status, lines: 0, bytes: 0, total: input.totalBytes, unparsed: 0, reason: null, newField: null });
      }
      this.busy.set(false);
    } catch (e) {
      this.failed(e, 'Could not create the source');
    }
  }

  /**
   * Adds an input; when the backend says this file was already loaded into the source
   * (409 DUPLICATE_FILE, clarification 2026-10-03) the user decides whether to load a second copy.
   */
  private async addInput(sourceId: string, body: Parameters<LogsApiService['addInput']>[1]): Promise<LogInput | null> {
    try {
      return await firstValueFrom(this.api.addInput(sourceId, body));
    } catch (e) {
      if ((e as { status?: number; error?: { error?: string } })?.error?.error !== 'DUPLICATE_FILE') throw e;
      const ok = await this.confirm.confirm('This file was already loaded into this source - load a second copy?', 'Load again');
      if (!ok) {
        this.busy.set(false);
        void this.router.navigate(['/logs', sourceId]);
        return null;
      }
      return firstValueFrom(this.api.addInput(sourceId, { ...body, confirmDuplicate: true }));
    }
  }

  /** Chunked, resumable upload (FR-003): each chunk stays under the gateway's body limit. */
  private async upload(sourceId: string): Promise<void> {
    const file = this.file()!;
    const ticket = await firstValueFrom(this.api.createUpload(file.name, file.size));
    const input = await this.addInput(sourceId, { kind: 'UPLOAD', ref: ticket.uploadId, fingerprint: await fingerprint(file) });
    if (!input) return;
    this.inputId.set(input.id);
    writePending({ uploadId: ticket.uploadId, name: file.name, size: file.size, sourceId, inputId: input.id });
    await this.sendChunks(file, ticket);
  }

  /** Resumes an interrupted upload: the user picks the same file again, only missing chunks are sent. */
  async resume(ev: Event): Promise<void> {
    const p = this.pending();
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!p || !file) return;
    if (file.name !== p.name || file.size !== p.size) {
      this.error.set(`Choose the same file to resume: ${p.name} (${this.mb(p.size)} GB).`);
      return;
    }
    this.error.set('');
    this.file.set(file);
    this.kind.set('UPLOAD');
    this.sourceId.set(p.sourceId);
    this.inputId.set(p.inputId);
    this.step.set(3);
    try {
      const ticket = await firstValueFrom(this.api.uploadStatus(p.uploadId));
      await this.sendChunks(file, ticket);
    } catch (e) {
      this.failed(e, 'Could not resume the upload');
    }
  }

  dropPending(): void {
    writePending(null);
    this.pending.set(null);
  }

  private async sendChunks(file: File, ticket: UploadTicket): Promise<void> {
    this.progress.set({ status: 'UPLOADING', lines: 0, bytes: 0, total: file.size, unparsed: 0, reason: null, newField: null });
    const chunks = Math.ceil(file.size / ticket.chunkSize);
    const done = new Set(ticket.receivedChunks);
    for (let i = 0; i < chunks; i++) {
      if (done.has(i)) continue;
      const blob = file.slice(i * ticket.chunkSize, Math.min(file.size, (i + 1) * ticket.chunkSize));
      let attempt = 0;
      for (;;) {
        try {
          await firstValueFrom(this.api.uploadChunk(ticket.uploadId, i, blob));
          break;
        } catch (e) {
          if (++attempt >= 3) throw e;
        }
      }
      this.uploadPct.set(Math.round(((i + 1) / chunks) * 100));
    }
    this.uploadPct.set(100);
    this.dropPending();
  }

  openExplorer(): void {
    const id = this.sourceId();
    if (id) void this.router.navigate(['/logs', id]);
  }

  goToStep(s: Step): void {
    if (s < this.step() && this.step() < 3) this.step.set(s);
  }

  mb(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(2);
  }
}

/** Same flattening as the backend's Flattener, for the template preview only. */
function flat(v: unknown, path = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(v) && v.length === 1) return flat(v[0], path, out);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flat(x, path ? `${path}.${k}` : k, out);
    return out;
  }
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return flat(JSON.parse(v), path, out);
    } catch {
      // not JSON after all
    }
  }
  out[path] = Array.isArray(v) ? JSON.stringify(v) : v;
  return out;
}
