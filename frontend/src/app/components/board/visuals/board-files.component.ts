import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BoardFileInfo, FILE_TYPES, FilePlace, MAX_FILE_BYTES } from '../../../core/models/snippet.models';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SnippetsApiService } from '../../../core/services/snippets-api.service';

/** 12.3 KB, 4.1 MB - a file's size as people say it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a file cannot be attached, before it is sent (the backend checks again, and checks the bytes). */
export function fileProblem(file: { name: string; size: number }): string | null {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!(FILE_TYPES as readonly string[]).includes(ext)) return `${file.name}: a file is one of ${FILE_TYPES.join(', ')}`;
  if (file.size > MAX_FILE_BYTES) return `${file.name}: a file can be at most 10 MB`;
  if (!file.size) return `${file.name} is empty`;
  return null;
}

/** The text a comment shows for an attached file: a link the board draws as a file chip. */
export function fileLink(f: Pick<BoardFileInfo, 'id' | 'name'>): string {
  return `[📎 ${f.name.replace(/[[\]]/g, '')}](/board/files/${f.id})`;
}

/**
 * The files of a card or a cycle (specs/017 R36): each with ⬇ (a download - the browser never opens it as a page) and,
 * where the board may be edited, ✕. 📎 attaches more. Re-read on /ws/board's `files` signal for this place.
 */
@Component({
  selector: 'app-board-files',
  standalone: true,
  template: `
    @if (list().length || canEdit()) {
      <div class="board-files">
        <span class="board-files-title">📎 Files</span>
        @for (f of list(); track f.id) {
          <span class="board-file-chip" [title]="f.mime + ' · ' + (f.author === 'CLAUDE' ? 'attached by Claude' : 'attached by you')">
            <a [href]="url(f.id)" [attr.download]="f.name">⬇ {{ f.name }}</a><span class="board-dim">{{ size(f.size) }}</span>
            @if (canEdit()) { <button type="button" class="board-file-x" title="Remove the file" (click)="remove(f)">✕</button> }
          </span>
        }
        @if (canEdit()) {
          <button type="button" class="action-btn" [disabled]="busy()" (click)="picker.click()">{{ busy() ? 'Attaching…' : '📎 Attach' }}</button>
          <input #picker type="file" multiple hidden [attr.accept]="accept" (change)="pick(picker)" />
        }
        @if (error(); as e) { <span class="board-error">{{ e }}</span> }
      </div>
    }`,
})
export class BoardFilesComponent {
  readonly card = input<string | null>(null);
  readonly cycle = input<string | null>(null);
  readonly project = input('');
  readonly canEdit = input(true);

  private readonly api = inject(SnippetsApiService);
  readonly list = signal<readonly BoardFileInfo[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly accept = FILE_TYPES.map((t) => '.' + t).join(',');
  readonly place = computed<FilePlace | null>(() => (this.card() ? { card: this.card()! } : this.cycle() ? { cycle: this.cycle()!, project: this.project() } : null));
  readonly size = fileSize;

  constructor() {
    effect(() => {
      this.place();
      untracked(() => void this.load());
    });
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type !== 'board-changed' || e.what !== 'files') return;
      if ((this.card() && e.cardId === this.card()) || (!this.card() && this.cycle() && e.cycleId === this.cycle() && !e.cardId)) void this.load();
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  url(id: string): string {
    return this.api.fileUrl(id);
  }

  async load(): Promise<void> {
    const p = this.place();
    if (!p) { this.list.set([]); return; }
    try {
      this.list.set(await firstValueFrom(this.api.files('card' in p ? { card: p.card } : { cycle: p.cycle })));
    } catch {
      this.list.set([]);
    }
  }

  async pick(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.attach(files);
  }

  /** Attaches each file in turn; the first refusal is shown and the rest still go. */
  async attach(files: readonly File[]): Promise<BoardFileInfo[]> {
    const p = this.place();
    const done: BoardFileInfo[] = [];
    if (!p) return done;
    this.error.set(null);
    this.busy.set(true);
    try {
      for (const f of files) {
        const problem = fileProblem(f);
        if (problem) { this.error.set(problem); continue; }
        try {
          done.push(await firstValueFrom(this.api.attach(p, f)));
        } catch (e) {
          this.error.set((e as { error?: { message?: string } })?.error?.message ?? `${f.name} could not be attached`);
        }
      }
    } finally {
      this.busy.set(false);
    }
    await this.load();
    return done;
  }

  async remove(f: BoardFileInfo): Promise<void> {
    if (!confirm(`Remove ${f.name} from the board? Texts that link to it will show it as gone.`)) return;
    try {
      await firstValueFrom(this.api.removeFile(f.id));
      await this.load();
    } catch (e) {
      this.error.set((e as { error?: { message?: string } })?.error?.message ?? 'The file could not be removed');
    }
  }
}
