import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { ChecklistFile, ChecklistItem, MARK_LABELS, Mark } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/**
 * The acceptance items of the cycle's spec files as a checklist the user marks pass / fail / can't tell, with evidence
 * (FR-050). Claude's own marks come with the later spec-verification feature; it reads these meanwhile.
 */
@Component({
  selector: 'app-acceptance-checklist',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    @if (files().length) {
      <div class="board-box">
        <h3>Acceptance checklist <small>marked by you</small></h3>
        @for (f of files(); track f.fileName) {
          <div class="board-dim board-check-file">from {{ f.fileName }}</div>
          <ul class="board-checklist">
            @for (item of f.items; track item.key) {
              <li>
                <span class="board-check-mark" [class]="'board-check-mark board-check-' + (item.mark?.mark ?? 'NONE')">{{ symbol(item) }}</span>
                <span class="board-check-text">{{ item.text }}</span>
                @if (item.mark?.evidence) { <span class="board-check-ev"><app-markdown-view [text]="item.mark!.evidence" /></span> }
                @if (editable()) {
                  <span class="board-check-acts">
                    @for (m of marks; track m) {
                      <button type="button" class="board-tog" [class.on]="item.mark?.mark === m" [title]="labels[m]" (click)="mark(f, item, m)">{{ labels[m] }}</button>
                    }
                    <button type="button" class="board-link" (click)="editing.set(editing() === item.key ? null : item.key)">evidence</button>
                  </span>
                }
                @if (editing() === item.key) {
                  <app-mention-editor [value]="item.mark?.evidence ?? ''" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                                      [cancellable]="true" [allowEmpty]="true" [rows]="2"
                                      (submitted)="mark(f, item, item.mark?.mark ?? 'CANT_TELL', $event)" (cancelled)="editing.set(null)" />
                }
                @if (item.mark; as mk) { <span class="board-dim board-check-when">{{ when(mk.updatedAt) }}</span> }
                @if (item.suggestion; as sg) {
                  <div class="board-check-suggest" [class]="'board-check-suggest board-check-' + sg.mark">
                    <span class="board-check-suggest-what">✦ Claude suggests {{ labels[sg.mark] }}</span>
                    @if (sg.evidence) { <app-markdown-view class="board-check-ev" [text]="sg.evidence" /> }
                    @if (editable()) {
                      <button type="button" class="board-tog on" title="Mark it as Claude suggests" (click)="acceptSuggestion(f, item)">Accept</button>
                      <button type="button" class="board-link" (click)="dismissSuggestion(f, item)">dismiss</button>
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      </div>
    }`,
})
export class AcceptanceChecklistComponent {
  private readonly api = inject(BoardApiService);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);

  readonly files = signal<readonly ChecklistFile[]>([]);
  readonly editing = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly labels = MARK_LABELS;

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId() && (e.what === 'checklist' || e.what === 'specs')),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  private load(id: string): void {
    this.api.checklist(id).subscribe({ next: (f) => this.files.set(f), error: (e) => this.error.set(messageOf(e)) });
  }

  symbol(item: ChecklistItem): string {
    switch (item.mark?.mark) {
      case 'PASS': return '✓';
      case 'FAIL': return '✗';
      case 'CANT_TELL': return '?';
      default: return '·';
    }
  }

  mark(file: ChecklistFile, item: ChecklistItem, mark: Mark, evidence?: string): void {
    this.editing.set(null);
    this.api.mark(this.cycleId(), file.fileName, item.key, mark, evidence ?? item.mark?.evidence ?? '').subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** The user's mark, with Claude's evidence. */
  acceptSuggestion(file: ChecklistFile, item: ChecklistItem): void {
    this.api.acceptSuggestion(this.cycleId(), file.fileName, item.key).subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  dismissSuggestion(file: ChecklistFile, item: ChecklistItem): void {
    this.api.dismissSuggestion(this.cycleId(), file.fileName, item.key).subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
