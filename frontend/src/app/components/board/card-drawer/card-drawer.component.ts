import { NgTemplateOutlet } from '@angular/common';
import { VerifyGuardService } from '../../../core/services/verify-guard.service';
import { Component, DestroyRef, HostListener, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import {
  ActivityEntry, CardDetail, CardKind, Proposal, CardStatus, FLAGS, FLAG_LABELS, Flag, KINDS, MentionRef, OPEN_STATUSES, RESOLUTION_LABELS,
  Resolution, SCOPE_LABELS, STATUS_LABELS, Scope, TextVersion,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { messageOf } from '../../../core/state/board-state.service';
import { proposalText } from '../board-card/board-card.component';
import { BoardSeenService } from '../../../core/services/board-seen.service';
import { issueMarkdown, skillFor, waitingText } from '../../../shared/utils/board-skills';
import { CardRetestComponent } from '../card-retest/card-retest.component';
import { LiveWorkBoxComponent } from '../live-work-box/live-work-box.component';
import { ActivityTimelineComponent, TimelineReply } from '../activity-timeline/activity-timeline.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';
import { RunSkillComponent } from '../run-skill/run-skill.component';
import { RunHistoryComponent } from '../run-skill/run-history.component';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { CardViewMode } from '../../../core/services/card-view-mode.service';
import { TeamsStateService } from '../../../core/state/teams-state.service';
import { ReturnPointService } from '../../../core/services/return-point.service';
import { SelectOption, SelectPickerComponent } from '../../select-picker/select-picker.component';

/**
 * One card opened (FR-027..029, mock "drawer"): status, kind, scope and flags; the description with its mentions; the
 * Linked list (mentions plus direct links); the full history; and a comment box. Re-reads itself whenever the board
 * says this card changed (`version`).
 */
import { BoardPagesComponent } from '../visuals/board-pages.component';
import { BoardFilesComponent } from '../visuals/board-files.component';
import { BoardPinnedComponent } from '../visuals/board-pinned.component';
import { QuickAnswerComponent } from '../quick-answer/quick-answer.component';
@Component({
  selector: 'app-card-drawer',
  standalone: true,
  imports: [BoardPagesComponent, BoardFilesComponent, BoardPinnedComponent, NgTemplateOutlet, SelectPickerComponent, ActivityTimelineComponent, CardRetestComponent, LiveWorkBoxComponent, MarkdownViewComponent, MentionChipComponent, MentionEditorComponent, MentionPickerComponent, RunSkillComponent, RunHistoryComponent, QuickAnswerComponent],
  template: `
    <ng-template #modeSwitch>
      <div class="board-seg board-drawer-modes" role="group" aria-label="Show the card as">
        @for (m of modes; track m.mode) {
          <button type="button" [class.on]="layout() === m.mode" [title]="m.title" (click)="layout() !== m.mode && modeChange.emit(m.mode)">{{ m.label }}</button>
        }
      </div>
    </ng-template>
    <aside class="board-drawer" [class.board-drawer-full]="layout() !== 'side'" [class.board-drawer-window]="layout() === 'window'"
           role="dialog" aria-label="Card">
      @if (card(); as c) {
        <div class="board-drawer-head">
          <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
          <ng-container *ngTemplateOutlet="modeSwitch" />
          <div class="board-card-row">
            <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span>
            @if (c.author === 'CLAUDE') { <span class="board-ai">✦ found by Claude</span> }
            @if (c.cycleId) { <span class="board-cyc">◷ {{ c.cycleDeleted ? 'cycle deleted' : c.cycleId }}</span> }
            <span class="board-dim">#{{ c.number }}</span>
            @if (waiting(); as w) { <span class="board-wait" [class]="'board-wait board-wait-' + c.waiting!.who">{{ w }}</span> }
            @if (c.openQuestions; as n) {
              <button type="button" class="board-qpill" [disabled]="!editable()" title="Claude's open questions - answer them in one go"
                      (click)="answering.set(true)">❓ {{ n }} open question{{ n === 1 ? '' : 's' }}</button>
            }
          </div>
          <div class="board-drawer-tools">
            @if (skill(); as cmd) {
              <app-run-skill #runSkill [command]="cmd" [project]="c.project" [cycleId]="inCycle() ? c.cycleId : null" [card]="c" [lastUserWord]="lastUserWord()"
                             [editable]="editable()" />
              <span class="board-dim run-keys" title="With the drawer open: R runs, C copies the prompt, Shift+R edits it first">R · C · ⇧R</span>
            }
            <button type="button" class="board-copy" title="Copy the card as Markdown for Jira / GitHub" (click)="copyIssue()">
              {{ copied() === 'issue' ? '✓ copied' : '⧉ Copy as issue' }}</button>
          </div>
          @if (editingTitle()) {
            <input #title class="board-drawer-title-input" type="text" maxlength="300" [value]="c.title"
                   (keydown.enter)="saveTitle(title.value)" (keydown.escape)="editingTitle.set(false)" (blur)="saveTitle(title.value)" />
          } @else {
            <h2 class="board-drawer-title" [title]="editable() ? 'Click to rename' : ''" (click)="editable() && editingTitle.set(true)">{{ c.title }}</h2>
          }
          <div class="board-drawer-controls">
            <span>Status
              <app-select-picker class="select-compact" [disabled]="!editable()" [options]="statusOptions" [value]="statusValue()"
                                 ariaLabel="Status" (valueChange)="changeStatus($event)" />
            </span>
            <span>Kind
              <app-select-picker class="select-compact" [disabled]="!editable()" [options]="kindOptions" [value]="c.kind"
                                 ariaLabel="Kind" (valueChange)="save({ kind: $any($event) })" />
            </span>
            <span>Scope
              <app-select-picker class="select-compact" [disabled]="!editable()" [options]="scopeOptions" [value]="c.scope"
                                 ariaLabel="Scope" (valueChange)="save({ scope: $any($event) })" />
            </span>
          </div>
          <div class="board-drawer-controls">
            @for (f of flags; track f) {
              <button type="button" class="board-tog" [class]="'board-tog board-flag-' + f" [class.on]="c.flags.includes(f)"
                      [disabled]="!editable()" (click)="toggleFlag(f)">{{ flagLabels[f] }}</button>
            }
          </div>
          <!-- Teams: who owns the fix - several when it spans them. Every change goes into the card's history. -->
          <div class="board-drawer-controls board-drawer-teams">
            <span>Teams</span>
            @for (t of cardTeams(); track t.id) {
              <span class="board-team" [style.--team]="t.color" [title]="t.owns">
                @if (t.icon) { <span aria-hidden="true">{{ t.icon }}</span> }{{ t.name }}
                @if (editable()) { <button type="button" class="board-team-x" [attr.aria-label]="'Remove ' + t.name" (click)="removeTeam(t.id)">✕</button> }
              </span>
            } @empty { <span class="board-dim">No team yet</span> }
            @if (editable() && otherTeams().length) {
              <app-select-picker class="board-team-add" [options]="teamOptions()" value="" placeholder="+ team" ariaLabel="Add a team"
                                 (valueChange)="addTeam($event)" />
            }
          </div>
          @if (c.reason) { <div class="board-card-reason">Reason: “{{ c.reason }}”</div> }
          @if (c.similarClosed; as s) { <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabels[s.resolution] }}{{ s.reason ? ': ' + s.reason : '' }}</div> }
          @if (c.proposal; as p) {
            <div class="board-proposal" role="group" aria-label="Claude's proposal">
              <div class="board-proposal-head"><b>✦ Claude proposes: {{ proposalText(p) }}</b></div>
              @if (p.reason) { <div class="board-proposal-reason">“{{ p.reason }}”</div> }
              @if (p.evidence) { <app-markdown-view class="board-proposal-evidence" [text]="p.evidence" /> }
              <div class="board-proposal-actions">
                <button type="button" class="action-btn primary" [disabled]="!editable()" (click)="acceptProposal()">Accept</button>
                <button type="button" class="action-btn" [disabled]="!editable()" (click)="dismissProposal()">Dismiss</button>
              </div>
            </div>
          }
        </div>
        <div class="board-drawer-body">
          <div class="board-drawer-main">
          <section class="board-drawer-desc">
            <h4>Description
              @if (editable() && !editingDescription()) { <button type="button" class="board-link" (click)="editingDescription.set(true)">Edit</button> }
              @if (descriptionEdited()) { <button type="button" class="board-link board-dim" title="See the earlier descriptions" (click)="showDescriptionHistory(c)">edited · history</button> }
            </h4>
            @if (descHistory(); as h) {
              <div class="run-dialog-bg" (click)="descHistory.set(null)">
                <div class="run-dialog board-versions" role="dialog" aria-label="Earlier descriptions" (click)="$event.stopPropagation()">
                  <div class="run-dialog-head"><b>Earlier descriptions</b><button type="button" class="board-link" (click)="descHistory.set(null)">✕</button></div>
                  <div class="board-version now"><div class="board-dim">Now</div><app-markdown-view [text]="c.description" empty="No description." /></div>
                  @for (v of h.versions; track $index) {
                    <div class="board-version"><div class="board-dim">{{ v.actor === 'CLAUDE' ? '✦ Claude' : 'You' }} · until {{ v.at }}</div><app-markdown-view [text]="v.text" empty="(empty)" /></div>
                  } @empty {
                    <div class="board-dim">{{ h.loading ? 'Loading…' : 'No earlier descriptions kept.' }}</div>
                  }
                </div>
              </div>
            }
            <app-board-pinned [owner]="'card:' + c.id" [canEdit]="editable()" [context]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" />
            @if (editingDescription()) {
              <app-mention-editor [value]="descriptionDraft() ?? c.description" [project]="c.project" [cycleId]="c.cycleId" [contextMentions]="c.links"
                                  [card]="pickTarget()" pickField="description" [attach]="{ card: c.id }"
                                  submitLabel="Save" [cancellable]="true" [allowEmpty]="true" [rows]="8" [enterSends]="false" [draftKey]="'desc:' + c.id"
                                  (submitted)="saveDescription($event)" (cancelled)="editingDescription.set(false); descriptionDraft.set(null)" />
            } @else {
              <div class="board-desc"><app-markdown-view [text]="c.description" empty="No description yet." [idPrefix]="'card-' + c.id + '-'" [outline]="true"
                [snippetOwner]="'inline:card:' + c.id + ':desc'" [snippetContext]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" /></div>
            }
            <app-board-pages [owner]="'card:' + c.id" [canEdit]="editable()" [context]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" />
            <app-board-files [card]="c.id" [canEdit]="editable()" />
          </section>
          </div>
          <div class="board-drawer-aside">
          <section class="board-drawer-linked">
            <h4>Linked <span class="board-dim">from mentions</span>
              @if (editable()) { <button type="button" class="board-link" (click)="linking.set(!linking())">+ link</button> }
            </h4>
            @if (linking()) {
              <app-mention-picker [project]="c.project" [cycleId]="c.cycleId" [calls]="callLinks()" [canPickAnywhere]="true"
                                (pickAnywhere)="pickLinksFromAnywhere()" (picked)="addLink($event)" (closed)="linking.set(false)" />
            }
            <div class="board-links">
              @for (m of c.links; track m.type + m.ref) { <app-mention-chip [mention]="m" /> } @empty { <span class="board-dim">Nothing linked.</span> }
            </div>
          </section>
          @if (c.specItems?.length) {
            <section class="board-drawer-spec">
              <h4>Breaks the spec</h4>
              @for (i of c.specItems; track i.fileName + i.itemKey) {
                <div class="board-spec-item">📄 {{ i.fileName }} · {{ i.text ?? '(item removed from the spec)' }}</div>
              }
            </section>
          }
          <section class="board-drawer-blocked">
            <h4>Blocked by
              @if (editable()) { <button type="button" class="board-link" (click)="blocking.set(!blocking())">+ blocked by…</button> }
            </h4>
            @if (blocking()) {
              <div class="board-block-add">
                <span>Card #</span><input #blockNo type="number" min="1" class="board-block-input" (keydown.enter)="block(blockNo.value)" />
                <button type="button" class="action-btn" (click)="block(blockNo.value)">Add</button>
                <button type="button" class="board-link" (click)="blocking.set(false)">Cancel</button>
              </div>
            }
            <div class="board-links">
              @for (b of c.blockedBy ?? []; track b.number) {
                <span class="board-lock-chip">🔒 #{{ b.number }} {{ b.title }} <span class="board-dim">({{ statusLabels[b.status] }})</span>
                  @if (editable()) { <button type="button" class="board-link" title="Not blocked by it any more" (click)="unblock(b.number)">✕</button> }
                </span>
              } @empty { <span class="board-dim">Not blocked.</span> }
            </div>
          </section>
          @if (c.status !== 'INBOX' && c.status !== 'CLOSED') {
            <app-card-retest class="board-drawer-retest" [card]="c" [version]="version()" [editable]="editable()" (retest)="retestRequested.emit(c.number)" />
          }
          </div>
          <section class="board-drawer-activity">
            <h4>Activity · what was done <span class="board-dim">{{ activityTotal() }} entries</span></h4>
            <app-activity-timeline [entries]="activity()" [editable]="editable()" [project]="c.project" [cycleId]="c.cycleId"
                                   [card]="pickTarget()" (replied)="reply($event)" (answerQuestions)="answering.set(true)" />
            <app-live-work-box [project]="c.project" [number]="c.number" [editable]="editable()" />
            <app-run-history [project]="c.project" [number]="c.number" />
          </section>
          @if (editable()) {
            <section class="board-drawer-danger">
              <button type="button" class="action-btn danger" (click)="remove()">Delete card…</button>
            </section>
          }
        </div>
        @if (editable()) {
          <div class="board-drawer-composer">
            <app-mention-editor [value]="draft()" (valueChange)="draft.set($event)" [project]="c.project" [cycleId]="c.cycleId"
                                [contextMentions]="c.links" [card]="pickTarget()" pickField="comment" [attach]="{ card: c.id }" [draftKey]="'comment:' + c.id" (submitted)="comment($event)" />
          </div>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
        @if (answering()) { <app-quick-answer [cardId]="c.id" (closed)="answering.set(false); load(c.id)" /> }
      } @else {
        <div class="board-drawer-head"><button type="button" class="board-drawer-x" (click)="closed.emit()">✕</button>
          <ng-container *ngTemplateOutlet="modeSwitch" />
          <span class="board-dim">{{ error() ?? 'Loading…' }}</span></div>
      }
    </aside>`,
})
export class CardDrawerComponent {
  private readonly api = inject(BoardApiService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly mentions = inject(BoardMentionsService);

  readonly cardId = input.required<string>();
  readonly version = input(0);
  readonly editable = input(true);
  /** Opened from a cycle's board: its ▶ runs in the cycle's chat (on the project board they copy). */
  readonly inCycle = input(false);
  /** ▐ Side, ⛶ Full or ↗ Window - the board decides; the switch in the header asks it to change. */
  readonly layout = input<CardViewMode>('side');
  readonly modeChange = output<CardViewMode>();
  readonly closed = output<void>();
  /** ▶ Re-test this card (specs/016): the board starts the recording. */
  readonly retestRequested = output<number>();
  readonly closeRequested = output<{ id: string; number: number; resolution: Resolution }>();

  readonly card = signal<CardDetail | null>(null);
  private readonly verifyGuard = inject(VerifyGuardService);
  /** The questions dialog is open over the drawer (specs/019). */
  readonly answering = signal(false);
  readonly activity = signal<readonly ActivityEntry[]>([]);
  readonly descriptionEdited = computed(() => this.activity().some((e) => e.kind === 'DESCRIPTION'));
  readonly descHistory = signal<{ versions: readonly TextVersion[]; loading: boolean } | null>(null);

  showDescriptionHistory(c: { id: string }): void {
    this.descHistory.set({ versions: [], loading: true });
    this.api.versions(`description:${c.id}`).subscribe({
      next: (versions) => this.descHistory.set({ versions, loading: false }),
      error: () => this.descHistory.set({ versions: [], loading: false }),
    });
  }
  readonly activityTotal = signal(0);
  readonly error = signal<string | null>(null);
  readonly editingTitle = signal(false);
  readonly editingDescription = signal(false);
  readonly linking = signal(false);
  readonly blocking = signal(false);
  readonly copied = signal<'cmd' | 'issue' | null>(null);
  private readonly seen = inject(BoardSeenService);
  /** "Now" for the waiting time, taken when the card is read - no clock of its own. */
  private readonly readAt = signal(Date.now());
  readonly waiting = computed(() => waitingText(this.card()?.waiting, this.readAt()));
  readonly skill = computed(() => {
    const c = this.card();
    return c ? skillFor(c) : null;
  });
  readonly runSkill = viewChild<RunSkillComponent>('runSkill');
  /** The user's latest words on the card - they go with the prompt ▶ sends. */
  readonly lastUserWord = computed(() => {
    const mine = this.activity().filter((e) => e.actor === 'USER' && e.kind === 'COMMENT' && e.text);
    return mine.length ? mine[mine.length - 1].text : null;
  });

  /** R runs the card's next step, C copies its prompt, Shift+R opens the editor - not while typing. */
  @HostListener('document:keydown', ['$event'])
  runKeys(event: KeyboardEvent): void {
    const run = this.runSkill();
    if (!run || event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('.dialog-backdrop, .run-dialog-bg')) return;
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      if (event.shiftKey && run.canRun()) run.openEditor(false); else run.go();
    } else if (event.key === 'c' && !event.shiftKey) {
      event.preventDefault();
      run.copyPrompt();
    }
  }
  readonly draft = signal('');
  /** The description being edited when a pick from anywhere came back into it. */
  readonly descriptionDraft = signal<string | null>(null);

  readonly modes: readonly { mode: CardViewMode; label: string; title: string }[] = [
    { mode: 'side', label: '▐ Side', title: 'Side panel - the board stays visible (Shift+F)' },
    { mode: 'full', label: '⛶ Full', title: 'Use the whole page (Shift+F)' },
    { mode: 'window', label: '↗ Window', title: 'Open in its own window' },
  ];
  readonly openStatuses = OPEN_STATUSES;
  readonly statusOptions: readonly SelectOption[] = [
    ...OPEN_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    ...(['FINE', 'NOT_IN_FLOW', 'WONT_FIX'] as const).map((r) => ({ value: 'CLOSED:' + r, label: 'Closed · ' + RESOLUTION_LABELS[r] })),
  ];
  readonly kindOptions: readonly SelectOption[] = KINDS.map((k) => ({ value: k, label: k }));
  readonly scopeOptions: readonly SelectOption[] = (['NOT_DECIDED', 'IN_SCOPE', 'OUT_OF_SCOPE'] as const).map((s) => ({ value: s, label: SCOPE_LABELS[s] }));
  readonly resolutions: readonly Resolution[] = ['FINE', 'NOT_IN_FLOW', 'WONT_FIX'];
  readonly kinds = KINDS;
  readonly flags = FLAGS;
  readonly scopes: readonly Scope[] = ['NOT_DECIDED', 'IN_SCOPE', 'OUT_OF_SCOPE'];
  readonly statusLabels = STATUS_LABELS;
  readonly resolutionLabels = RESOLUTION_LABELS;
  readonly scopeLabels = SCOPE_LABELS;
  readonly flagLabels = FLAG_LABELS;

  readonly statusValue = computed(() => {
    const c = this.card();
    return !c ? '' : c.status === 'CLOSED' ? `CLOSED:${c.resolution}` : c.status;
  });
  readonly pickTarget = computed(() => {
    const c = this.card();
    return c ? { id: c.id, project: c.project, number: c.number, cycleId: c.cycleId } : null;
  });
  private readonly teamsState = inject(TeamsStateService);
  private readonly returns = inject(ReturnPointService);
  readonly cardTeams = computed(() => this.teamsState.of(this.card()?.teams));
  readonly otherTeams = computed(() => {
    const on = new Set(this.card()?.teams ?? []);
    return this.teamsState.teams().filter((t) => !on.has(t.id));
  });
  readonly teamOptions = computed<SelectOption[]>(() => this.otherTeams().map((t) => ({ value: t.id, label: `${t.icon ? t.icon + ' ' : ''}${t.name}` })));
  readonly callLinks = computed(() => (this.card()?.links ?? []).filter((m) => m.type.toLowerCase() === 'call'));

  constructor() {
    this.teamsState.load();
    inject(DestroyRef).onDestroy(() => {
      if (this.returns.openCard()?.number === this.card()?.number) this.returns.openCard.set(null);
    });
    effect(() => {
      const id = this.cardId();
      this.version();
      untracked(() => this.load(id));
    });
  }

  load(id: string): void {
    this.api.card(id).subscribe({
      next: (c) => {
        this.readAt.set(Date.now());
        this.card.set(c);
        this.returns.openCard.set({ project: c.project, number: c.number, title: c.title });
        this.error.set(null);
        this.seen.markSeen(c);
        this.restorePickedText(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
    this.api.activity(id).subscribe({
      next: (page) => {
        this.activity.set(page.entries);
        this.activityTotal.set(page.total);
      },
      error: () => undefined,
    });
  }

  private apply(call: ReturnType<BoardApiService['update']>): void {
    call.subscribe({
      next: (c) => {
        this.card.set(c);
        this.error.set(null);
        this.load(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  proposalText(p: Proposal): string {
    return proposalText(p);
  }

  copy(text: string, what: 'cmd' | 'issue'): void {
    void copyToClipboard(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  /** The card as a Markdown issue for another team (specs/015 FR-18). */
  copyIssue(): void {
    const c = this.card();
    if (c) this.copy(issueMarkdown(c, this.activity()), 'issue');
  }

  addTeam(id: string): void {
    const c = this.card();
    if (c && id) this.apply(this.api.assignTeams(c.id, [...(c.teams ?? []), id]));
  }

  removeTeam(id: string): void {
    const c = this.card();
    if (c) this.apply(this.api.assignTeams(c.id, (c.teams ?? []).filter((t) => t !== id)));
  }

  block(value: string): void {
    const c = this.card();
    const n = Number(value);
    if (!c || !Number.isInteger(n) || n < 1) return;
    this.blocking.set(false);
    this.apply(this.api.block(c.id, n));
  }

  unblock(number: number): void {
    const c = this.card();
    if (c) this.apply(this.api.unblock(c.id, number));
  }

  /** Takes Claude's proposed step as the user's own. */
  acceptProposal(): void {
    const c = this.card();
    if (c) this.apply(this.api.acceptProposal(c.id));
  }

  dismissProposal(): void {
    const c = this.card();
    if (c) this.apply(this.api.dismissProposal(c.id));
  }

  save(edit: { kind?: CardKind; scope?: Scope; flags?: readonly Flag[]; title?: string; description?: string }): void {
    const c = this.card();
    if (c) this.apply(this.api.update(c.id, edit));
  }

  saveTitle(title: string): void {
    this.editingTitle.set(false);
    const c = this.card();
    if (c && title.trim() && title.trim() !== c.title) this.save({ title: title.trim() });
  }

  saveDescription(text: string): void {
    this.editingDescription.set(false);
    this.descriptionDraft.set(null);
    this.save({ description: text });
  }

  toggleFlag(f: Flag): void {
    const c = this.card();
    if (!c) return;
    this.save({ flags: c.flags.includes(f) ? c.flags.filter((x) => x !== f) : [...c.flags, f] });
  }

  changeStatus(value: string): void {
    const c = this.card();
    if (!c) return;
    if (value.startsWith('CLOSED:')) {
      const resolution = value.slice('CLOSED:'.length) as Resolution;
      if (c.status === 'CLOSED') {
        // a different resolution on a closed card: reopen, then close again, so the history shows both
        this.api.reopen(c.id).subscribe({ next: () => this.closeRequested.emit({ id: c.id, number: c.number, resolution }),
          error: (e) => this.error.set(messageOf(e)) });
      } else {
        this.closeRequested.emit({ id: c.id, number: c.number, resolution });
      }
      return;
    }
    if (c.status === 'CLOSED') {
      this.api.reopen(c.id).subscribe({
        next: () => (value === 'INBOX' ? this.load(c.id) : this.apply(this.api.move(c.id, value as CardStatus))),
        error: (e) => this.error.set(messageOf(e)),
      });
      return;
    }
    if (value === 'VERIFIED') {
      void this.verifyGuard.verify(c, () => this.apply(this.api.move(c.id, 'VERIFIED')));
      return;
    }
    this.apply(this.api.move(c.id, value as CardStatus));
  }

  /** "+ link" → Pick from anywhere: the picked calls come back as links on this card. */
  pickLinksFromAnywhere(): void {
    const target = this.pickTarget();
    if (!target) return;
    this.linking.set(false);
    this.mentions.pickForCard(target, { kind: 'links' });
  }

  /** Back from a pick started in the comment box or the description: the text, with the picked calls in it, is put back. */
  private restorePickedText(cardId: string): void {
    const back = this.mentions.takePickedText(cardId);
    if (!back) return;
    if (back.field === 'comment') {
      this.draft.set(back.text);
    } else {
      this.descriptionDraft.set(back.text);
      this.editingDescription.set(true);
    }
  }

  addLink(ref: MentionRef): void {
    this.linking.set(false);
    const c = this.card();
    if (c) this.apply(this.api.link(c.id, ref));
  }

  comment(text: string): void {
    const c = this.card();
    if (!c) return;
    this.api.comment(c.id, text).subscribe({
      next: () => {
        this.draft.set('');
        this.load(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** A reply (or an answer to Claude's question) written under a comment in the history. */
  reply(r: TimelineReply): void {
    const c = this.card();
    if (!c) return;
    this.api.comment(c.id, r.text, r.replyTo, r.clearDecision).subscribe({
      next: () => this.load(c.id),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  remove(): void {
    const c = this.card();
    if (!c) return;
    this.confirm.confirm(`Delete card #${c.number} “${c.title}” and its whole history? This cannot be undone.`, 'Delete').then((ok) => {
      if (!ok) return;
      this.api.delete(c.id).subscribe({ next: () => this.closed.emit(), error: (e) => this.error.set(messageOf(e)) });
    });
  }
}
