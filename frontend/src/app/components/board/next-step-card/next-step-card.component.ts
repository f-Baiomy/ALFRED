import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BoardStage } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { AppConfigService } from '../../../core/services/app-config.service';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { BoardBannerService } from '../../../core/state/board-banner.service';
import { SessionsStateService } from '../../../core/state/sessions-state.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { skillPrompt } from '../../../shared/utils/skill-prompt';
import { otherSteps, stepCopy } from '../../../shared/utils/stage-copy';
import { recordForBoard } from '../record-line/record-line.component';

/** What the Claude button should do so a step runs: start (or resume) Claude, then run it. */
export interface ClaudeAsk {
  readonly command: string;
  readonly prompt: string;
}

/**
 * The Next card (specs/032 D1/D2/T045): the one next step `BoardStage.of` picked, in plain words, and one button that does
 * it - asking the Claude that answers the board, or starting / resuming Claude first and then running it. ⧉ Copy for
 * terminal gives the exact command for people who run Claude themselves; Other steps ▾ lists every step.
 */
@Component({
  selector: 'app-next-step-card',
  standalone: true,
  imports: [CloseOnOutsideDirective],
  styles: [`
    .next { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px 16px; border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--purple) 40%, transparent);
      background: linear-gradient(135deg, color-mix(in srgb, var(--purple) 10%, transparent), transparent 60%); }
    .ic { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 10px; background: color-mix(in srgb, var(--purple) 20%, transparent); font-size: 19px; }
    .k { font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--purple-light); }
    .t { margin: 1px 0 3px; font-size: 16px; font-weight: 600; }
    .d { color: var(--text-dim); font-size: 13px; }
    .acts { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
    .row { display: flex; gap: 6px; justify-content: flex-end; }
    .go { font-size: 13px; padding: 7px 14px; }
    .rel { position: relative; }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 70; min-width: 290px; padding: 6px; background: var(--popover-solid);
      border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: 0 14px 34px rgba(0,0,0,.5); }
    .mi { display: flex; flex-direction: column; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--text);
      font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .mi small { color: var(--text-dim); font-size: 11.5px; }
    .mi code { font-size: 11px; }
    .mi:hover:not(:disabled) { background: color-mix(in srgb, var(--purple) 14%, transparent); }
    .mi:disabled { opacity: .55; cursor: default; }
    .sep { height: 1px; margin: 5px 4px; background: var(--border); }
    @media (max-width: 760px) { .next { grid-template-columns: 42px minmax(0, 1fr); } .acts { grid-column: 1 / -1; } .row { justify-content: flex-start; } }
  `],
  template: `
    @if (copy(); as c) {
      <div class="next" role="region" aria-label="Next step">
        <div class="ic" aria-hidden="true">{{ c.icon }}</div>
        <div><div class="k">Next step</div><div class="t">{{ c.title }}</div><div class="d">{{ c.detail }}</div></div>
        <div class="acts">
          <button type="button" class="action-btn primary go" [disabled]="primaryOff()" [title]="primaryTitle()" (click)="primary()">{{ primaryLabel() }}</button>
          <div class="row">
            @if (c.command; as cmd) {
              <button type="button" class="action-btn" [title]="'Copies ' + cmd + ' - paste it into Claude Code'" (click)="copyText(cmd)">{{ copied() === cmd ? '✓ Copied' : '⧉ Copy for terminal' }}</button>
            }
            <span class="rel" [appCloseOnOutside]="menu()" (closed)="menu.set(false)">
              <button type="button" class="action-btn" [attr.aria-expanded]="menu()" (click)="menu.set(!menu())">Other steps ▾</button>
              @if (menu()) {
                <div class="menu" role="menu">
                  @for (s of others(); track s.skill) {
                    <button type="button" role="menuitem" class="mi" [disabled]="!editable() || claude().mode === 'busy' || claude().mode === 'held'" (click)="runOther(s.command)">
                      {{ s.label }}<small>{{ s.what }} · <code>{{ s.command }}</code></small></button>
                  }
                  <div class="sep"></div>
                  <button type="button" role="menuitem" class="mi" (click)="copyText(resumeCmd()); menu.set(false)">Continue on another machine<small>copies {{ resumeCmd() }}</small></button>
                </div>
              }
            </span>
          </div>
        </div>
      </div>
    }`,
})
export class NextStepCardComponent {
  private readonly api = inject(BoardApiService);
  private readonly chatApi = inject(ChatApiService);
  private readonly runs = inject(SkillRunsStateService);
  private readonly sessions = inject(SessionsStateService);
  private readonly cycleState = inject(SessionCyclesStateService);
  private readonly mentions = inject(BoardMentionsService);
  private readonly banner = inject(BoardBannerService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly config = inject(AppConfigService);

  readonly project = input('');
  readonly boardId = input.required<string>();
  readonly boardName = input<string | null>(null);
  readonly stage = input<BoardStage | null>(null);
  /** A terminal /alfred-live (or a cycle chat) answers the board. */
  readonly terminalOn = input(false);
  readonly cycles = input<readonly Pick<SessionCycle, 'id' | 'name' | 'status'>[]>([]);
  readonly editable = input(true);
  /** Claude is not on: the Claude button starts (or resumes) it, then runs this. */
  readonly askClaude = output<ClaudeAsk>();

  readonly menu = signal(false);
  readonly copied = signal<string | null>(null);
  readonly sending = signal(false);
  readonly copy = computed(() => (this.stage() ? stepCopy(this.stage()!) : null));
  readonly claude = computed(() => this.sessions.claude(this.boardId(), this.terminalOn()));
  readonly recording = computed(() => this.cycles().some((c) => c.status === 'RECORDING'));
  readonly others = computed(() => otherSteps(this.stage()?.ref ?? this.boardId()));
  readonly resumeCmd = computed(() => `/alfred-resume ${this.stage()?.ref ?? this.boardId()}`);
  /** Claude answers the board now - the step can be asked of it directly. */
  readonly claudeOn = computed(() => ['on', 'terminal', 'elsewhere'].includes(this.claude().mode));

  readonly primaryLabel = computed(() => {
    const c = this.copy();
    if (!c) return '';
    if (c.kind === 'USER') return 'Open them';
    if (c.kind === 'RECORD' && !this.recording()) return `● Record and ${c.verb}`;
    if (this.sending()) return 'Sending…';
    switch (this.claude().mode) {
      case 'busy': return 'Claude is getting ready…';
      case 'held': return `${this.claude().label.replace(/^🔒 /, '')} answers this board`;
      case 'paused': return `▶ Resume Claude and ${c.verb}`;
      case 'start':
      case 'failed': return `▶ Start Claude and ${c.verb}`;
      default: return `▶ Ask Claude to ${c.verb}`;
    }
  });
  readonly primaryOff = computed(() => {
    const c = this.copy();
    if (!c || c.kind === 'USER') return false;
    if (!this.editable() || this.sending()) return true;
    if (c.kind === 'RECORD' && !this.recording()) return false;
    return this.claude().mode === 'busy' || this.claude().mode === 'held';
  });
  readonly primaryTitle = computed(() => {
    const c = this.copy();
    if (!this.editable()) return 'This view of the board is read-only';
    if (c?.kind === 'USER') return 'Opens the first card waiting on you';
    if (this.claude().mode === 'held') return this.claude().tooltip;
    return c?.command ? `Runs ${c.command}` : '';
  });

  constructor() {
    effect(() => {
      this.runs.watch(this.project());
      this.runs.watchCycle(this.project(), this.boardId());
    }, { allowSignalWrites: true });
  }

  async primary(): Promise<void> {
    const c = this.copy();
    if (!c) return;
    if (c.kind === 'USER') { this.openWaiting(); return; }
    if (c.kind === 'RECORD' && !this.recording()) {
      const r = await recordForBoard(this.api, this.confirmDialog, this.boardId());
      if (r && 'error' in r) { this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Recording did not start', detail: r.error }); return; }
      if (!r) return;
      this.cycleState.refreshNow();
    }
    if (c.command) this.run(c.command);
  }

  runOther(command: string): void {
    this.menu.set(false);
    this.run(command);
  }

  /** Asks the Claude that answers the board, or has the Claude button start / resume it with the step to follow. */
  run(command: string): void {
    const prompt = skillPrompt({ command, alfredUrl: this.config.backendUrl, project: this.project(), cycleId: this.boardId(),
      cycleName: this.boardName(), card: null, lastUserWord: null });
    if (!this.claudeOn()) { this.askClaude.emit({ command, prompt }); return; }
    this.sending.set(true);
    const done = () => this.sending.set(false);
    const fail = (e: HttpErrorResponse) => {
      done();
      this.banner.show({ boardId: this.boardId(), tone: 'error', text: `${command} was not sent`, detail: e?.error?.message ?? e?.message ?? null });
    };
    const chat = (this.runs.cycles(), this.runs.chat(this.boardId()));
    if (chat) {
      this.runs.run({ project: this.project(), cycleId: this.boardId(), cardNumber: null, command, prompt, note: null })
        .subscribe({ next: () => { done(); this.sent(command); }, error: fail });
    } else {
      // a terminal /alfred-live reads the board chat: the step goes there as the user's own message
      this.chatApi.post(this.project(), this.boardId(), { text: command }).subscribe({ next: () => { done(); this.sent(command); }, error: fail });
    }
  }

  private sent(command: string): void {
    this.banner.show({ boardId: this.boardId(), key: 'next', tone: 'ok', text: `Sent to Claude: ${this.copy()?.title ?? command}`,
      detail: 'It works in the board\'s session - its progress shows on the cards and in the chat.' });
  }

  openWaiting(): void {
    this.api.nextSteps(this.project(), this.boardId()).subscribe({
      next: (s) => {
        const first = s.waitingOnUser[0];
        if (first) this.mentions.cardToOpen.set({ project: this.project(), number: first.number });
      },
      error: () => undefined,
    });
  }

  copyText(text: string): void {
    void copyToClipboard(text);
    this.copied.set(text);
    setTimeout(() => this.copied.set(null), 1500);
  }
}
