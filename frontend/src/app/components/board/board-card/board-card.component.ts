import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import {
  CardStatus, CardSummary, FLAG_LABELS, Proposal, RESOLUTION_BUTTONS, RESOLUTION_LABELS, Resolution, RetestCheck, ageText, implementedChip, isStale,
  retestChip, workedChip,
} from '../../../core/models/board.models';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { RefTextComponent } from '../mention-chip/ref-text.component';
import { proposalTarget } from '../../../shared/utils/board-activity';
import { skillFor, waitingPill } from '../../../shared/utils/board-skills';
import { BoardSeenService } from '../../../core/services/board-seen.service';
import { TeamChipsComponent } from '../team-chips/team-chips.component';
import { RunSkillComponent } from '../run-skill/run-skill.component';
import type { WaitingAnchor } from '../waiting-bar/waiting-bar.component';
import { LiveWorkStateService, currentStep } from '../../../core/state/live-work-state.service';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { actionText, adviceAction, confidenceLabel, confidenceOf } from '../../../shared/utils/triage-advice';
import { homeLabel, placementOf } from '../../../shared/utils/board-cards-visibility';

/** What a card asks of its board: one sort action, a reopen, or a selection toggle. */
export type CardAction =
  | { readonly kind: 'close'; readonly resolution: Resolution }
  | { readonly kind: 'move'; readonly status: CardStatus }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'retest' }
  | { readonly kind: 'merge'; readonly into: number }
  | { readonly kind: 'mergeGroup'; readonly group: readonly number[] };

/**
 * One card on the board (mock-v2): kind, flags, title, the first mentions, number, author, cycle, comments, scope and
 * age. Inbox cards carry the one-click sort (Fine / Not in flow / To do), closed ones their resolution and Reopen.
 */
@Component({
  selector: 'app-board-card',
  standalone: true,
  imports: [MentionChipComponent, RefTextComponent, TeamChipsComponent, RunSkillComponent],
  template: `
    <div class="board-card" [class.live-busy]="!!liveWork()" [class.selected]="selected()" [class.focused]="focused()" [class.closed]="card().status === 'CLOSED'"
         [class.blocked]="!!card().blockedBy?.length" [class.related]="!placement().own" [attr.data-card]="card().id" tabindex="-1" (click)="onClick($event)">
      @if (unread()) { <span class="board-unread" title="Claude changed it since you last opened it"></span> }
      @if (editable()) {
        <button type="button" class="board-card-check" [class.on]="selected()" title="Select (X or Shift+click)"
                (click)="$event.stopPropagation(); toggled.emit()">{{ selected() ? '✓' : '' }}</button>
      }
      <div class="board-card-row">
        <button type="button" class="board-card-num" [class.copied]="copied()" [title]="copied() ? 'Copied' : 'Copy #' + card().number"
                (click)="copyNumber($event)">{{ copied() ? '✓ copied' : '#' + card().number }}</button>
        <span class="board-kind" [class]="'board-kind board-kind-' + card().kind">{{ card().kind }}</span>
        @for (f of card().flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabel(f) }}</span> }
      </div>
      <div class="board-card-title"><app-ref-text [text]="card().title" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div>
      @if (toAzure(); as n) {
        <button type="button" class="tob-pill" title="Changes Claude prepared for Azure wait for your approval - open the card"
                (click)="$event.stopPropagation(); opened.emit()">⇪ {{ n }} to Azure</button>
      }
      @if (questionCount(); as n) {
        <button type="button" class="board-qpill" [disabled]="!editable()" [title]="editable() ? 'Answer the questions (A)' : 'Open questions from Claude'"
                (click)="$event.stopPropagation(); answer.emit()">❓ {{ n }} open question{{ n === 1 ? '' : 's' }}</button>
        @if (card().advice; as a) {
          <span class="board-advice" [title]="adviceTitle()">✦ advises: {{ a }}@if (confidence(); as cf) { <span class="board-conf" [class]="'board-conf board-conf-' + cf.toLowerCase()">{{ confidenceText(cf) }}</span> }</span>
          @if (card().adviceDetail?.reason; as why) {
            <div class="board-advice-why" [title]="why"><b>Why:</b> <app-ref-text [text]="why" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div>
          }
        }
      }
      @if (card().status === 'INBOX' && card().adviceDetail?.rank; as r) {
        <span class="board-sev" [title]="card().adviceDetail?.note ?? 'Claude ranks the Inbox worst first'">▲ {{ r }}{{ card().adviceDetail?.of ? ' of ' + card().adviceDetail?.of : '' }}{{ card().adviceDetail?.note ? ' · ' + card().adviceDetail?.note : '' }}</span>
      }
      @if (card().teams?.length) { <div class="board-card-row board-card-teams"><app-team-chips [teams]="card().teams" /></div> }
      @if (card().mentionChips?.length) {
        <div class="board-card-row">
          @for (m of card().mentionChips; track m.type + m.ref) { <app-mention-chip [mention]="m" [showPreview]="false" /> }
        </div>
      }
      <div class="board-card-foot">
        @if (card().author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> }
        @if (home(); as h) { <span class="board-home" title="This card lives on another board and shows here through a relation">⌂ {{ h }}</span> }
        @if (showCycle() && card().cycleId) {
          <span class="board-cyc" [class.gone]="card().cycleDeleted">◷ {{ card().cycleDeleted ? 'cycle deleted' : cycleLabel() }}</span>
        }
        @if (card().commentCount) { <span>💬 {{ card().commentCount }}</span> }
        @if (!card().resolution) {
          <span class="board-scope" [class.in]="card().scope === 'IN_SCOPE'" [class.out]="card().scope === 'OUT_OF_SCOPE'">{{ scopeText() }}</span>
        }
        <span class="board-age" [class.stale]="stale()" [title]="stale() ? 'No change for more than 5 days' : ''">{{ stale() ? '⏳ ' : '' }}{{ age() }}</span>
      </div>
      @if (liveWork(); as lw) {
        <div class="board-card-live" role="status"><span class="live-spinner"></span>✦ {{ liveStep(lw) }}</div>
      }
      @if (waiting(); as w) {
        <div class="board-card-row"><button type="button" class="board-wait board-wait-btn" [class]="'board-wait board-wait-btn board-wait-' + card().waiting!.who"
                [title]="'What this card waits on - decide or discuss here'" aria-haspopup="dialog" (click)="openWaiting($event)">{{ w }} ▾</button></div>
      }
      @if (checks(); as two) {
        <!-- specs/026: a Fixed card is ready for Verified when it is implemented AND it worked -->
        <div class="board-vchecks">
          @for (k of two; track k.text) {
            <div class="board-vcheck" [class]="'board-vcheck board-vcheck-' + k.tone" [title]="k.text + (k.detail ? ' - ' + k.detail : '')">
              <b>{{ k.text }}</b>@if (k.detail) { <span>{{ k.detail }}</span> }
            </div>
          }
        </div>
      }
      @if (!checks() && chip(); as ch) {
        <div class="board-card-row"><span class="board-retest" [class]="'board-retest board-retest-' + ch.tone"
              [title]="'Re-test: ' + retest()!.summary">{{ ch.text }}</span></div>
      }
      @if (card().blockedBy?.length) {
        <div class="board-card-lock">🔒 Blocked by @for (b of card().blockedBy; track b.number) { <b>#{{ b.number }}</b> {{ b.title }} }</div>
      }
      @if (card().resolution; as r) {
        <div class="board-card-row"><span class="board-res" [class]="'board-res board-res-' + r">{{ resolutionLabel(r) }}</span></div>
        @if (card().reason) { <div class="board-card-reason">“<app-ref-text [text]="card().reason" [project]="card().project" [cycleId]="card().cycleId" [card]="card().number" [showPreview]="false" />”</div> }
      }
      @if (card().status === 'INBOX' && card().similarClosed; as s) {
        <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabel(s.resolution) }}{{ s.reason ? ': ' + s.reason : '' }}</div>
      }
      @if (card().proposal; as p) {
        <div class="board-card-proposal" title="Open the card to accept or dismiss">✦ Claude proposes {{ proposalText(p) }}</div>
      }
      @if (editable() && card().status === 'INBOX') {
        <div class="board-card-acts">
          <button type="button" class="ok" [class.advised]="advised() === 'FINE'" title="Fine - not an issue (F)" (click)="act($event, { kind: 'close', resolution: 'FINE' })">{{ buttons.FINE }}</button>
          <button type="button" [class.advised]="advised() === 'NOT_IN_FLOW'" title="Not in this flow (N)" (click)="act($event, { kind: 'close', resolution: 'NOT_IN_FLOW' })">{{ buttons.NOT_IN_FLOW }}</button>
          <button type="button" [class.advised]="advised() === 'TO_DO'" title="To do (T)" (click)="act($event, { kind: 'move', status: 'TO_DO' })">→ To do</button>
          @if (mergeAdvice(); as m) {
            <button type="button" class="advised" [title]="'Claude advises: ' + mergeText(m)" (click)="act($event, m)">⇢ {{ mergeText(m) }}</button>
          }
        </div>
      }
      @if (editable() && card().status === 'CLOSED') {
        <div class="board-card-acts"><button type="button" (click)="act($event, { kind: 'reopen' })">↺ Reopen</button></div>
      }
      @if (editable() && card().status === 'FIXED') {
        <div class="board-card-acts">
          @if (retest()?.verdict === 'PASSES') {
            <button type="button" class="ok" title="Every call since the fix passes - move to Verified" (click)="act($event, { kind: 'move', status: 'VERIFIED' })">✓ Verified</button>
          }
          <button type="button" title="Record a re-test of this card - its steps show on the strip" (click)="act($event, { kind: 'retest' })">▶ Re-test</button>
        </div>
      }
      @if (skill(); as cmd) {
        <span class="board-card-run" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
          <app-run-skill [command]="cmd" [project]="card().project" [cycleId]="showCycle() ? null : card().cycleId" [cycleName]="cycleName()" [card]="card()" [editable]="editable()" />
        </span>
      }
    </div>`,
})
export class BoardCardComponent {
  readonly card = input.required<CardSummary>();
  readonly selected = input(false);
  readonly focused = input(false);
  readonly editable = input(true);
  readonly showCycle = input(true);
  readonly cycleName = input<string | null>(null);
  readonly now = input(Date.now());
  /** The card's re-test (specs/016): its Fixed check or its guard, null when there is none. */
  readonly retest = input<RetestCheck | null>(null);
  /** The board being looked at (specs/027): a card homed elsewhere is drawn dashed with its home. */
  readonly viewBoard = input<string | null>(null);
  readonly boardNames = input<ReadonlyMap<string, string>>(new Map());
  readonly placement = computed(() => placementOf(this.card(), this.viewBoard()));
  readonly home = computed(() => homeLabel(this.placement(), this.boardNames()));
  readonly opened = output<void>();
  readonly toggled = output<void>();
  readonly action = output<CardAction>();
  /** Answer from the board (specs/015 FR-5): the card has a question waiting on the user. */
  readonly answer = output<void>();
  /** The waiting pill clicked: open the waiting bar under it (the host draws it, like the questions dialog). */
  readonly waitingOpen = output<WaitingAnchor>();

  private readonly seen = inject(BoardSeenService);
  private readonly outbox = inject(BundleOutboxService);
  /** Changes waiting to go to Azure from this card (specs/034). */
  readonly toAzure = computed(() => (this.outbox.byCard().get(this.card().id) ?? []).reduce((n, b) => n + b.steps.filter((x) => x.ticked).length, 0));
  private readonly live = inject(LiveWorkStateService);
  /** /alfred-live working on this card right now. */
  readonly copied = signal(false);

  openWaiting(e: MouseEvent): void {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.waitingOpen.emit({ top: r.top, bottom: r.bottom, left: r.left });
  }

  /** The number pill copies `#53` - the way the board and Claude mention a card - without opening the card. */
  copyNumber(e: Event): void {
    e.stopPropagation();
    void copyToClipboard('#' + this.card().number).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1200);
    });
  }

  readonly liveWork = computed(() => this.live.working().find((w) => w.project === this.card().project && w.cardNumber === this.card().number) ?? null);
  readonly liveStep = currentStep;
  readonly unread = computed(() => this.seen.isUnread(this.card()));
  readonly waiting = computed(() => waitingPill(this.card(), this.now()));
  readonly skill = computed(() => skillFor(this.card()));
  readonly chip = computed(() => {
    const r = this.retest();
    return r && (this.card().status === 'FIXED' || this.card().status === 'VERIFIED' || this.card().status === 'DONE') ? retestChip(r) : null;
  });
  readonly hasOpenQuestion = computed(() => this.questionCount() > 0);
  /** A Fixed card's two checks (specs/026): implemented, and worked. */
  readonly checks = computed(() => {
    const r = this.retest();
    return r && this.card().status === 'FIXED' ? [implementedChip(r), workedChip(r)] : null;
  });
  /** How sure Claude is of its advice (triage): High, Medium or Low. */
  readonly confidence = computed(() => this.card().openQuestions ? confidenceOf(this.card()) : null);
  readonly confidenceText = confidenceLabel;
  readonly adviceTitle = computed(() => {
    const d = this.card().adviceDetail;
    return ['What Claude recommends - open the question for the full answer', d?.reason ? `Why: ${d.reason}` : '', d?.checked ? `Checked: ${d.checked}` : '']
      .filter(Boolean).join('\n');
  });
  /** A merge Claude advises - into another card, or its root-cause group into this one - as a button. */
  readonly mergeAdvice = computed((): CardAction | null => {
    const a = adviceAction(this.card());
    return a && (a.kind === 'merge' || a.kind === 'mergeGroup') ? a : null;
  });

  mergeText(a: CardAction): string {
    return a.kind === 'merge' || a.kind === 'mergeGroup' ? actionText(a) : '';
  }
  /** The sort button Claude's open question recommends (specs/020) - outlined; using it answers the question. */
  readonly advised = computed(() => adviceButton(this.card().openQuestions ? this.card().advice : null));
  /** Claude's open questions (specs/019) - shown whatever the card's status or what else it waits on; an older backend: its flag. */
  readonly questionCount = computed(() => this.card().openQuestions
    ?? (this.card().waiting?.who === 'USER' && this.card().flags.includes('NEEDS_DECISION') ? 1 : 0));

  readonly buttons = RESOLUTION_BUTTONS;
  readonly stale = computed(() => isStale(this.card(), this.now()));
  readonly age = computed(() => ageText(this.card().updatedAt, this.now()));
  readonly cycleLabel = computed(() => this.cycleName() ?? this.card().cycleId ?? '');
  readonly scopeText = computed(() => {
    const s = this.card().scope;
    return s === 'IN_SCOPE' ? 'in scope' : s === 'OUT_OF_SCOPE' ? 'out of scope' : 'scope?';
  });

  flagLabel(f: keyof typeof FLAG_LABELS): string {
    return FLAG_LABELS[f];
  }

  proposalText(p: Proposal): string {
    return proposalText(p);
  }

  resolutionLabel(r: Resolution): string {
    return RESOLUTION_LABELS[r];
  }

  onClick(event: MouseEvent): void {
    if (event.shiftKey && this.editable()) {
      this.toggled.emit();
      return;
    }
    this.opened.emit();
  }

  act(event: Event, action: CardAction): void {
    event.stopPropagation();
    this.action.emit(action);
  }
}

/** "Verified", "close as Fine - not an issue", "merge into #11", "reopen (regression)". */
export function proposalText(p: Proposal): string {
  if (p.kind === 'MERGE') return proposalTarget(`MERGE:#${p.intoNumber}`);
  if (p.kind === 'REOPEN') return proposalTarget('REOPEN');
  return proposalTarget(p.status === 'CLOSED' && p.resolution ? `CLOSED:${p.resolution}` : p.status);
}

/** "To do" → TO_DO, "Fine" → FINE, "Not in this flow" → NOT_IN_FLOW; anything else (a merge) has no button. */
export function adviceButton(advice: string | null | undefined): 'FINE' | 'NOT_IN_FLOW' | 'TO_DO' | null {
  const a = (advice ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (a === 'to do' || a.startsWith('to do ')) return 'TO_DO';
  if (a === 'fine' || a.startsWith('fine ')) return 'FINE';
  if (a.startsWith('not in this flow') || a.startsWith('not in flow')) return 'NOT_IN_FLOW';
  return null;
}
