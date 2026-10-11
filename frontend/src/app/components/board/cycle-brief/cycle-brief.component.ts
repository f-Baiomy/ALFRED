import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { CycleBrief, SessionLogEntry, TestStep } from '../../../core/models/board.models';
import { skillArg } from '../../../shared/utils/board-skills';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { copyToClipboard } from '../../../shared/utils/clipboard';

/**
 * What a session cycle is for (FR-030): Markdown with mentions, edited in place - by the user or by Claude
 * (/alfred-setup, /alfred-spec; "edited by Claude" and Restore previous, specs/015). Below it: the test steps ticked by
 * listen / review, Claude's session log, and the skill commands for this cycle.
 */
@Component({
  selector: 'app-cycle-brief',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    <div class="board-box">
      <h3>Cycle brief
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
        <app-mention-editor [value]="brief()?.text ?? ''" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                            [cancellable]="true" [allowEmpty]="true" [rows]="6"
                            placeholder="What is this cycle for? The task, the steps recorded, the rules in use… type @ to mention"
                            (submitted)="save($event)" (cancelled)="editing.set(false)" />
      } @else {
        <app-markdown-view [text]="brief()?.text ?? ''" [idPrefix]="'brief-' + cycleId() + '-'"
                           empty="No brief yet - say what this cycle is for, which task, the steps and the specs." />
      }
      @if (steps().length) {
        <div class="board-steps">
          <h4>Test steps <span class="board-dim">ticked by /alfred-listen and /alfred-review</span></h4>
          @for (st of steps(); track st.key; let i = $index) {
            <div class="board-step" [class]="'board-step board-step-' + st.state">
              <span class="board-step-mark">{{ st.state === 'SEEN' ? '✓' : st.state === 'FAILED' ? '✗' : '·' }}</span>
              <span>{{ i + 1 }}. {{ st.text }}</span>
              <span class="board-step-note">{{ st.state === 'SEEN' ? st.calls + ' call' + (st.calls === 1 ? '' : 's')
                : st.state === 'FAILED' ? (st.cardNumber ? 'card #' + st.cardNumber : 'failed') + (st.note ? ' · ' + st.note : '') : 'not tested yet' }}</span>
            </div>
          }
        </div>
      }
      @if (log().length) {
        <div class="board-log">
          <h4>Claude's session log</h4>
          @for (e of log(); track e.id) {
            <div class="board-log-entry">
              <div class="board-dim">✦ Claude · /{{ e.skill }} · {{ when(e.at) }}</div>
              <div><span class="board-ev-label">DID</span>{{ e.did }}</div>
              <div><span class="board-ev-label">FOUND</span>{{ e.found }}</div>
              <div><span class="board-ev-label">NEXT</span>{{ e.next }}</div>
            </div>
          }
        </div>
      }
      <div class="board-cycle-cmds">
        @for (cmd of commands(); track cmd) {
          <button type="button" class="board-copy" [title]="'Copy ' + cmd + ' - paste it into Claude Code'" (click)="copy(cmd)">
            {{ copied() === cmd ? '✓ copied' : '⧉ ' + cmd }}</button>
        }
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

  readonly steps = signal<readonly TestStep[]>([]);
  readonly log = signal<readonly SessionLogEntry[]>([]);
  readonly copied = signal<string | null>(null);

  commands(): string[] {
    const arg = skillArg(this.cycleName() ?? this.cycleId());
    return [`/alfred-review ${arg}`, `/alfred-listen ${arg}`, `/alfred-spec ${arg}`];
  }

  readonly brief = signal<CycleBrief | null>(null);
  readonly editing = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId() && ['brief', 'steps', 'log'].includes(e.what)),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  private load(id: string): void {
    this.api.brief(id).subscribe({ next: (b) => this.brief.set(b), error: (e) => this.error.set(messageOf(e)) });
    this.api.steps(id).subscribe({ next: (s) => this.steps.set(s), error: () => this.steps.set([]) });
    this.api.sessionLog(id, 10).subscribe({ next: (l) => this.log.set(l), error: () => this.log.set([]) });
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

  restore(): void {
    this.api.restoreBrief(this.cycleId()).subscribe({
      next: (b) => {
        this.brief.set(b);
        this.load(this.cycleId());
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  copy(text: string): void {
    void copyToClipboard(text).then(() => {
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
