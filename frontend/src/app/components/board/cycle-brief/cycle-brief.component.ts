import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { CycleBrief } from '../../../core/models/board.models';
import { skillArg } from '../../../shared/utils/board-skills';
import { briefParts, decisionsOf, itemsOf } from '../../../shared/utils/task-view';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { RunSkillComponent } from '../run-skill/run-skill.component';

/** A section item this short shows as a chip; longer ones as a line. */
const CHIP_MAX = 48;

/**
 * The task a session cycle is for (FR-030, skills/_shared/rules.md §0): Markdown with mentions, edited in place - by
 * the user or by Claude (/alfred-setup, /alfred-spec; "edited by Claude" and Restore previous, specs/015). Shown by
 * its sections - the goal, the ticket's description as written, scope, out of scope and the decisions every later
 * session must keep; Test steps and Data show beside it in the Task view. A brief without sections shows whole.
 */
import { BoardPagesComponent } from '../visuals/board-pages.component';
@Component({
  selector: 'app-cycle-brief',
  standalone: true,
  imports: [BoardPagesComponent, MarkdownViewComponent, MentionEditorComponent, RunSkillComponent],
  template: `
    <div class="board-box">
      <h3 class="task-h3">The task
        <small>
          @if (brief()?.updatedBy === 'CLAUDE') { <span class="board-ai">✦ edited by Claude</span> · }
          @if (brief()?.updatedAt) { edited {{ when(brief()!.updatedAt!) }} · }
          @if (editable() && brief()?.hasPrevious && !editing()) {
            <button type="button" class="board-link" title="Put back the brief this edit replaced (a second click undoes it)" (click)="restore()">Restore previous</button> ·
          }
          @if (editable() && !editing()) { <button type="button" class="board-link" (click)="editing.set(true)">Edit</button> }
        </small>
      </h3>
      @if (editing()) {
        <app-mention-editor [value]="brief()?.text ?? template" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                            [cancellable]="true" [allowEmpty]="true" [rows]="14" [enterSends]="false" [draftKey]="'brief:' + cycleId()"
                            placeholder="What is this task? The ticket, its description, scope, test steps… type @ to mention"
                            (submitted)="save($event)" (cancelled)="editing.set(false)" />
      } @else {
        @let p = parts();
        @if (p.goal) { <div class="task-goal"><app-markdown-view [text]="p.goal" [idPrefix]="'brief-' + cycleId() + '-goal-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':goal'" [snippetContext]="{ cycleId: cycleId() }" /></div> }
        @if (p.sections['description'] || p.sections['scope'] || p.sections['out of scope']) {
          <div class="task-brief-grid">
            <div>
              @if (p.sections['description']) {
                <div class="task-rl">Description <span>as the ticket says it</span></div>
                <div class="task-desc"><app-markdown-view [text]="p.sections['description']" [idPrefix]="'brief-' + cycleId() + '-desc-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':desc'" [snippetContext]="{ cycleId: cycleId() }" /></div>
              }
            </div>
            <div>
              @if (scope().length) {
                <div class="task-rl">Scope</div>
                <div class="task-chips">@for (s of scope(); track $index) { <span [class]="s.length > chipMax ? 'task-line' : 'task-chip'">{{ s }}</span> }</div>
              }
              @if (outOfScope().length) {
                <div class="task-rl">Out of scope <span>never carded</span></div>
                <div class="task-chips">@for (s of outOfScope(); track $index) { <span [class]="s.length > chipMax ? 'task-line task-dim' : 'task-chip task-dim'">{{ s }}</span> }</div>
              }
            </div>
          </div>
        }
        @if (decisions().length) {
          <div class="task-rl">Decisions <span>binding for every session</span></div>
          @for (d of decisions(); track $index) {
            <div class="task-dec">@if (d.date) { <span class="board-dim">{{ d.date }}</span> } {{ d.text }}</div>
          }
        }
        @for (o of p.other; track $index) {
          @if (o.title) { <div class="task-rl">{{ o.title }}</div> }
          <app-markdown-view [text]="o.text" [idPrefix]="'brief-' + cycleId() + '-o' + $index + '-'" [snippetOwner]="'inline:cycle:' + cycleId() + ':o' + $index" [snippetContext]="{ cycleId: cycleId() }" />
        }
        @if (!brief()?.text?.trim()) {
          <div class="board-dim">No brief yet - say what the task is: the ticket, its description, scope, test steps.
            @if (editable()) { <button type="button" class="board-link" (click)="editing.set(true)">Start from the template</button> }
            or <code>/alfred-setup</code> drafts it from the ticket.</div>
        }
      }
      @if (project()) {
        <app-board-pages [owner]="'cycle:' + cycleId()" [project]="project()" [canEdit]="editable()" [context]="{ cycleId: cycleId(), project: project() }" />
      }
      <div class="task-harness">
        <span class="task-rl">Continue anywhere</span>
        <span class="board-dim">a new session, another machine or another agent loads this task from Alfred:</span>
        <app-run-skill [command]="resume()" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [copyOnly]="true" />
        <span class="board-dim">or any /alfred-* skill (they start with task_context)</span>
      </div>
      @if (error()) { <div class="board-error">{{ error() }}</div> }
    </div>`,
})
export class CycleBriefComponent {
  private readonly api = inject(BoardApiService);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);
  /** The cycle's name, for the commands to copy (its id when not given). */
  readonly cycleName = input<string | null>(null);
  /** Each brief loaded or saved - the Task view reads its Test steps and Data from it. */
  readonly briefChange = output<CycleBrief>();

  readonly chipMax = CHIP_MAX;
  readonly template = '<one line: what the task delivers>\n\n## Task\n- <ticket id / link>, branch <name>\n\n## Description\n<what the ticket asks for, as written>\n\n'
    + '## Scope\n- \n\n## Out of scope\n- \n\n## Test steps\n1. \n\n## Data\n- \n\n## Decisions\n';
  readonly brief = signal<CycleBrief | null>(null);
  readonly editing = signal(false);
  readonly error = signal<string | null>(null);

  readonly parts = computed(() => briefParts(this.brief()?.text ?? ''));
  readonly scope = computed(() => itemsOf(this.parts().sections['scope']));
  readonly outOfScope = computed(() => itemsOf(this.parts().sections['out of scope']));
  readonly decisions = computed(() => decisionsOf(this.parts().sections['decisions']));
  readonly resume = computed(() => `/mcp__alfred__resume ${skillArg(this.cycleName() ?? this.cycleId())}`);

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
    this.api.brief(id).subscribe({ next: (b) => this.set(b), error: (e) => this.error.set(messageOf(e)) });
  }

  private set(b: CycleBrief): void {
    this.brief.set(b);
    this.briefChange.emit(b);
  }

  save(text: string): void {
    this.api.putBrief(this.cycleId(), text).subscribe({
      next: (b) => {
        this.set(b);
        this.editing.set(false);
        this.error.set(null);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  restore(): void {
    this.api.restoreBrief(this.cycleId()).subscribe({
      next: (b) => this.set(b),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
