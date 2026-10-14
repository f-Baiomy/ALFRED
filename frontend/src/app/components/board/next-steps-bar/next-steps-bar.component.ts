import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NextSteps } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { skillArg } from '../../../shared/utils/board-skills';
import { BoardStateService } from '../../../core/state/board-state.service';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { AppConfigService } from '../../../core/services/app-config.service';
import { skillPrompt } from '../../../shared/utils/skill-prompt';
import { RunSkillComponent } from '../run-skill/run-skill.component';

/**
 * One line above the columns (specs/015 FR-3): what waits on the user (oldest first), then what waits on Claude, on a
 * re-test, and in the Inbox - each with the /alfred-* command to paste into Claude Code. Re-read whenever the board's
 * cards are (`version`), never on a timer.
 */
@Component({
  selector: 'app-next-steps-bar',
  standalone: true,
  imports: [RunSkillComponent],
  template: `
    @if (steps(); as s) {
      @if (hasAnything()) {
        <div class="board-next" role="status">
          @if (s.waitingOnUser.length) {
            <span class="board-next-you">⚑ {{ s.waitingOnUser.length }} wait{{ s.waitingOnUser.length === 1 ? 's' : '' }} on you</span>
            @for (w of s.waitingOnUser.slice(0, 6); track w.number) {
              <button type="button" class="board-link" [title]="w.title + ' - ' + why(w.why)" (click)="opened.emit(w.number)">#{{ w.number }}</button>
            }
            @if (s.waitingOnUser.length > 6) { <span class="board-dim">+{{ s.waitingOnUser.length - 6 }}</span> }
            <span class="board-dim">·</span>
          }
          @if (s.toDo + s.inProgress) {
            <span>{{ s.toDo }} To do{{ s.inProgress ? ' · ' + s.inProgress + ' in progress' : '' }}</span>
            <app-run-skill command="/alfred-fix" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [editable]="editable()" />
            <span class="board-dim">·</span>
          }
          @if (s.fixed) {
            <span>{{ s.fixed }} Fixed need a re-test</span>
            <app-run-skill [command]="verifyCmd()" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [editable]="editable()" />
            @if (canRunEach() && fixedCards().length > 1) {
              <button type="button" class="board-copy" [title]="'Run /alfred-verify on each Fixed card, one run per card (' + fixedCards().length + ')'"
                      (click)="runEach()">{{ eachSent() ? '✓ ' + eachSent() : '▶ each card (' + fixedCards().length + ')' }}</button>
            }
            <span class="board-dim">·</span>
          }
          @if (s.inbox) {
            <span>{{ s.inbox }} in the Inbox</span>
            <app-run-skill command="/alfred-triage" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [editable]="editable()" />
          }
          <span class="board-next-status"><app-run-skill command="/alfred-status" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [editable]="editable()" /></span>
        </div>
      }
    }`,
})
export class NextStepsBarComponent {
  private readonly api = inject(BoardApiService);
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input<string | null>(null);
  /** Bumped by the board whenever its cards are re-read. */
  readonly version = input<unknown>(null);
  readonly opened = output<number>();

  readonly steps = signal<NextSteps | null>(null);
  readonly hasAnything = computed(() => {
    const s = this.steps();
    return !!s && (s.waitingOnUser.length + s.toDo + s.inProgress + s.fixed + s.inbox) > 0;
  });
  private readonly board = inject(BoardStateService, { optional: true });
  private readonly runs = inject(SkillRunsStateService);
  private readonly config = inject(AppConfigService);
  readonly editable = computed(() => this.board?.editable() ?? true);
  /** The cycle's Fixed cards - "▶ each card" sends /alfred-verify for each into the cycle's chat, which runs them one after another. */
  readonly fixedCards = computed(() => (this.board?.cards() ?? []).filter((c) => c.status === 'FIXED' && !!this.cycleId() && c.cycleId === this.cycleId()));
  readonly canRunEach = computed(() => (this.runs.cycles(), this.editable() && !!this.runs.chat(this.cycleId())));
  readonly eachSent = signal<string | null>(null);
  readonly verifyCmd = computed(() => `/alfred-verify ${this.cycleName() ? skillArg(this.cycleName()!) : ''}`.trimEnd());

  constructor() {
    effect(() => {
      const project = this.project();
      const cycleId = this.cycleId();
      this.version();
      untracked(() => this.api.nextSteps(project, cycleId).subscribe({ next: (s) => this.steps.set(s), error: () => this.steps.set(null) }));
    });
  }

  why(w: string): string {
    return w === 'question' ? 'a question waits for your answer' : w === 'proposal' ? 'a proposal waits for Accept / Dismiss'
      : w === 'inbox' ? 'a finding waits to be sorted' : 'waits on you';
  }

  runEach(): void {
    const cards = this.fixedCards();
    let ok = 0;
    let done = 0;
    for (const c of cards) {
      const command = `/alfred-verify ${c.number}`;
      this.runs.run({ project: c.project, cycleId: c.cycleId, cardNumber: c.number, command,
        prompt: skillPrompt({ command, alfredUrl: this.config.backendUrl, project: c.project, cycleId: c.cycleId, cycleName: this.cycleName(), card: c }) })
        .subscribe({ next: () => { ok++; }, error: () => undefined, complete: () => undefined })
        .add(() => {
          done++;
          if (done === cards.length) {
            this.eachSent.set(`${ok} of ${cards.length} sent`);
            setTimeout(() => this.eachSent.set(null), 4000);
          }
        });
    }
  }
}
