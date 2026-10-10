import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SpecFileInfo } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';

/** The largest spec file accepted - the backend refuses more (FR-031, research R17). */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const ACCEPTED = /\.(md|txt)$/i;

/** Why a file cannot be a spec, or null when it can. */
export function specFileProblem(name: string, size: number): string | null {
  if (!ACCEPTED.test(name)) return `“${name}” is not a spec file - only .md and .txt are accepted`;
  if (size > MAX_SPEC_BYTES) return `“${name}” is larger than 5 MB`;
  return null;
}

/**
 * A cycle's spec files (FR-031..033): drop or pick .md / .txt files, or paste text with a name; the same name replaces
 * the file. Clicking one opens the viewer.
 */
@Component({
  selector: 'app-spec-files',
  standalone: true,
  template: `
    <div class="board-box">
      <h3>Spec files <small>.md · .txt</small></h3>
      <div class="board-files">
        @for (f of files(); track f.name) {
          <div class="board-file" role="button" tabindex="0" (click)="show(f.name)" (keydown.enter)="show(f.name)">
            <span class="board-file-ext">{{ ext(f.name) }}</span> {{ f.name }}
            <span class="board-dim board-file-meta">{{ size(f.size) }} · {{ when(f.uploadedAt) }}</span>
            @if (editable()) { <button type="button" class="board-link" title="Delete" (click)="$event.stopPropagation(); remove(f.name)">✕</button> }
          </div>
        }
        @if (editable()) {
          <div class="board-drop" [class.over]="over()" (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)"
               (drop)="onDrop($event)">
            Drop .md / .txt here, or <label class="board-link">choose<input type="file" accept=".md,.txt,text/markdown,text/plain" multiple hidden
              (change)="onPick($any($event.target))" /></label>, or <button type="button" class="board-link" (click)="pasting.set(!pasting())">paste text</button>
          </div>
          @if (pasting()) {
            <div class="board-paste">
              <input #name type="text" placeholder="name.md" maxlength="200" />
              <textarea #text rows="6" placeholder="Paste the spec here"></textarea>
              <button type="button" class="action-btn primary" (click)="paste(name.value, text.value)">Save</button>
            </div>
          }
        }
      </div>
      @if (message()) { <div class="board-error">{{ message() }}</div> }
    </div>`,
})
export class SpecFilesComponent {
  private readonly api = inject(BoardApiService);
  private readonly mentions = inject(BoardMentionsService);
  readonly cycleId = input.required<string>();
  readonly editable = input(true);

  readonly files = signal<readonly SpecFileInfo[]>([]);
  readonly over = signal(false);
  readonly pasting = signal(false);
  readonly message = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId() && e.what === 'specs'),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  private load(id: string): void {
    this.api.specs(id).subscribe({ next: (f) => this.files.set(f), error: (e) => this.message.set(messageOf(e)) });
  }

  show(name: string): void {
    this.mentions.specToShow.set({ cycleId: this.cycleId(), name, section: null });
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
    this.upload(Array.from(event.dataTransfer?.files ?? []));
  }

  onPick(input: HTMLInputElement): void {
    this.upload(Array.from(input.files ?? []));
    input.value = '';
  }

  paste(name: string, text: string): void {
    const clean = name.trim() || 'pasted.md';
    const fileName = ACCEPTED.test(clean) ? clean : `${clean}.md`;
    this.send(fileName, text);
    this.pasting.set(false);
  }

  private upload(files: File[]): void {
    for (const file of files) {
      const problem = specFileProblem(file.name, file.size);
      if (problem) {
        this.message.set(problem);
        continue;
      }
      void file.text().then((text) => this.send(file.name, text));
    }
  }

  private send(name: string, text: string): void {
    this.api.putSpec(this.cycleId(), name, text).subscribe({
      next: (r) => {
        this.message.set(r.replaced ? `Replaced ${r.name}` : null);
        this.load(this.cycleId());
      },
      error: (e) => this.message.set(messageOf(e)),
    });
  }

  remove(name: string): void {
    this.api.deleteSpec(this.cycleId(), name).subscribe({ next: () => this.load(this.cycleId()), error: (e) => this.message.set(messageOf(e)) });
  }

  ext(name: string): string {
    return (name.split('.').pop() ?? '').toUpperCase();
  }

  size(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
