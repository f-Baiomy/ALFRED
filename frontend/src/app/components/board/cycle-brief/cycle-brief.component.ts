import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { CycleBrief } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/** What a session cycle is for (FR-030): Markdown with mentions, edited in place. */
@Component({
  selector: 'app-cycle-brief',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    <div class="board-box">
      <h3>Cycle brief
        <small>
          @if (brief()?.updatedAt) { edited {{ when(brief()!.updatedAt!) }} · }
          @if (editable() && !editing()) { <button type="button" class="board-link" (click)="editing.set(true)">Edit</button> }
        </small>
      </h3>
      @if (editing()) {
        <app-mention-editor [value]="brief()?.text ?? ''" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                            [cancellable]="true" [allowEmpty]="true" [rows]="6"
                            placeholder="What is this cycle for? The task, the steps recorded, the rules in use… type @ to mention"
                            (submitted)="save($event)" (cancelled)="editing.set(false)" />
      } @else {
        <app-markdown-view [text]="brief()?.text ?? ''" [idPrefix]="'brief-' + cycleId() + '-'"
                           empty="No brief yet - say what this cycle is for, which task, the steps and the specs." />
      }
      @if (error()) { <div class="board-error">{{ error() }}</div> }
    </div>`,
})
export class CycleBriefComponent {
  private readonly api = inject(BoardApiService);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);

  readonly brief = signal<CycleBrief | null>(null);
  readonly editing = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId() && e.what === 'brief'),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  private load(id: string): void {
    this.api.brief(id).subscribe({ next: (b) => this.brief.set(b), error: (e) => this.error.set(messageOf(e)) });
  }

  save(text: string): void {
    this.api.putBrief(this.cycleId(), text).subscribe({
      next: (b) => {
        this.brief.set(b);
        this.editing.set(false);
        this.error.set(null);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
