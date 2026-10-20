import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { userLabel } from '../../../core/links/remote-ref';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  CardStatus, CardSummary, FLAG_LABELS, Flag, MENTION_ICONS, Proposal, mentionTypeOf, RESOLUTION_BUTTONS, RESOLUTION_LABELS, Resolution, RetestCheck, ageText, implementedChip, isStale,
  retestChip, workedChip, defaultBoardId,
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
import { AutoDirDirective } from '../../../shared/directives/auto-dir.directive';
import { QuestionsFormService } from '../../../core/services/questions-form.service';

/** What a card asks of its board: one sort action, a reopen, or a selection toggle. */
export type CardAction =
  | { readonly kind: 'close'; readonly resolution: Resolution }
  | { readonly kind: 'move'; readonly status: CardStatus }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'retest' }
  | { readonly kind: 'merge'; readonly into: number }
  | { readonly kind: 'mergeGroup'; readonly group: readonly number[] }
  | { readonly kind: 'acceptProposal' }
  | { readonly kind: 'dismissProposal' };

/**
 * One card on the board (mock-v2): kind, flags, title, the first mentions, number, author, cycle, comments, scope and
 * age. Inbox cards carry the one-click sort (Fine / Not in flow / To do), closed ones their resolution and Reopen.
 */
@Component({
  selector: 'app-board-card',
  standalone: true,
  imports: [MentionChipComponent, RefTextComponent, TeamChipsComponent, RunSkillComponent, AutoDirDirective, NgTemplateOutlet],
  template: `
    @if (compact()) {
    <!-- Compact (the default): head, title, the one state that matters most, a meta row and the actions; the rest is in the hover peek -->
    <div class="board-card bcc" [class]="'board-card bcc bcc-k-' + card().kind" [class.live-busy]="!!liveWork()" [class.selected]="selected()" [class.focused]="focused()"
         [class.closed]="card().status === 'CLOSED'" [class.blocked]="!!card().blockedBy?.length" [class.related]="!placement().own" [class.asks]="asks()"
         [attr.data-card]="card().id" tabindex="-1" (click)="onClick($event)"
         (mouseenter)="hovered.emit($any($event.currentTarget))" (mouseleave)="hovered.emit(null)">
      @if (editable()) {
        <button type="button" class="board-card-check" [class.on]="selected()" title="Select (X or Shift+click)"
                (click)="$event.stopPropagation(); toggled.emit()">{{ selected() ? '✓' : '' }}</button>
      }
      <div class="bcc-head">
        <span class="board-kind" [class]="'board-kind board-kind-' + card().kind">{{ kindLabel() }}</span>
        <button type="button" class="board-card-num" [class.copied]="copied()" [title]="copied() ? 'Copied' : 'Copy #' + card().number"
                (click)="copyNumber($event)">{{ copied() ? '✓' : '#' + card().number }}</button>
        @if (unread()) { <span class="board-unread" title="Claude changed it since you last opened it"></span> }
        @for (f of card().flags; track f) {
          <span class="board-flag" [class]="'board-flag board-flag-' + f" [attr.data-icon]="flagIcon(f)" [title]="flagLabel(f)">{{ flagLabel(f) }}</span>
        }
        @if (waitShort(); as w) {
          <button type="button" class="board-wait board-wait-btn bcc-wait" [class]="'board-wait board-wait-btn bcc-wait board-wait-' + card().waiting!.who"
                  [title]="waiting() + ' - decide or discuss here'" aria-haspopup="dialog" (click)="openWaiting($event)">⏳ {{ w }} ▾</button>
        }
      </div>
      <div class="board-card-title" [appAutoDir]="card().title"><app-ref-text [text]="card().title" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div>
      @switch (primary()) {
        @case ('live') {
          <div class="bcc-state bcc-live" role="status"><span class="live-spinner"></span><span class="bcc-cut">✦ {{ liveStep(liveWork()!) }}</span>@if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('question') {
          <button type="button" class="bcc-state bcc-q" [disabled]="!editable()" [title]="editable() ? 'Answer the questions (A)' : 'Open questions from Claude'"
                  (click)="$event.stopPropagation(); answer.emit()">
            <span class="bcc-qn">❓ {{ questionCount() }} question{{ questionCount() === 1 ? '' : 's' }}</span>
            @if (card().advice; as a) {
              <span class="bcc-adv" [title]="adviceTitle()">· ✦ <bdi [appAutoDir]="a">{{ a }}</bdi></span>
              @if (confidence(); as cf) { <span class="board-conf" [class]="'board-conf board-conf-' + cf.toLowerCase()">{{ confidenceText(cf) }}</span> }
            }
            @if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }
            @if (editable()) { <span class="bcc-go">Answer ›</span> }
          </button>
        }
        @case ('checks') {
          <div class="bcc-state board-vchecks">
            @for (k of checks()!; track k.text) {
              <div class="board-vcheck" [class]="'board-vcheck board-vcheck-' + k.tone" [title]="k.text + (k.detail ? ' - ' + k.detail : '')">
                <b>{{ k.text }}</b>@if (k.detail) { <span>{{ k.detail }}</span> }
              </div>
            }
            @if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }
          </div>
        }
        @case ('retest') {
          <div class="bcc-state"><span class="board-retest" [class]="'board-retest board-retest-' + chip()!.tone" [title]="'Re-test: ' + retest()!.summary">{{ chip()!.text }}</span>@if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('blocked') {
          <div class="bcc-state board-card-lock"><span class="bcc-cut">🔒 Blocked by @for (b of card().blockedBy; track b.number) { <b>#{{ b.number }}</b> {{ b.title }} }</span>@if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('similar') {
          <div class="bcc-state board-sim"><span class="bcc-cut">⚠ Looks like #{{ card().similarClosed!.number }}, closed as {{ resolutionLabel(card().similarClosed!.resolution) }}</span>@if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('azure') {
          <div class="bcc-state"><button type="button" class="tob-pill" title="Changes Claude prepared for Azure wait for your approval - open the card"
                  (click)="$event.stopPropagation(); opened.emit()">⇪ {{ toAzure() }} to Azure</button>@if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('resolution') {
          <div class="bcc-state"><span class="board-res" [class]="'board-res board-res-' + card().resolution">{{ resolutionLabel(card().resolution!) }}</span>
            @if (card().reason) { <span class="bcc-cut bcc-reason" [appAutoDir]="card().reason">“{{ card().reason }}”</span> }
            @if (extra()) { <span class="bcc-more">+{{ extra() }}</span> }</div>
        }
        @case ('rank') {
          <div class="bcc-state"><span class="board-sev bcc-cut" [title]="card().adviceDetail?.note ?? 'Claude ranks the Inbox worst first'">▲ {{ card().adviceDetail?.rank }}{{ card().adviceDetail?.of ? ' of ' + card().adviceDetail?.of : '' }}{{ card().adviceDetail?.note ? ' · ' + card().adviceDetail?.note : '' }}</span></div>
        }
      }
      @if (card().proposal; as p) { <ng-container *ngTemplateOutlet="proposalBox; context: { $implicit: p }" /> }
      <div class="bcc-meta">
        @if (card().teams?.length) { <app-team-chips class="bcc-teams" [teams]="card().teams" /> }
        @for (m of mentionCounts(); track m.icon) { <span class="bcc-count" [title]="m.title">{{ m.icon }}{{ m.n }}</span> }
        @if (card().author === 'CLAUDE') { <span class="board-ai" title="Made by Claude">✦</span> }
        @if (home(); as h) { <span class="board-home" [title]="'Lives on ' + h + ' - shown here through a relation'">⌂</span> }
        @if (showCycle() && card().cycleId) {
          <span class="board-cyc" [class.gone]="card().cycleDeleted" [title]="card().cycleDeleted ? 'cycle deleted' : cycleLabel()">◷</span>
        }
        @if (card().commentCount) { <span class="bcc-comments" [title]="card().commentCount + ' comments'">💬 {{ card().commentCount }}</span> }
        <span class="board-age" [class.stale]="stale()" [title]="stale() ? 'No change for more than 5 days' : 'Last change'">{{ stale() ? '⏳ ' : '' }}{{ shortAge() }}</span>
        @if (skill() && !hasActs()) {
          <span class="board-card-run bcc-run" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
            <app-run-skill [command]="skill()!" [project]="card().project" [cycleId]="showCycle() ? null : card().cycleId" [cycleName]="cycleName()" [card]="card()" [editable]="editable()" />
          </span>
        }
      </div>
      @if (hasActs()) {
        <div class="board-card-acts" [class.bcc-acts-mini]="card().status !== 'INBOX'">
          @if (card().status === 'INBOX') {
            <button type="button" class="ok" [class.advised]="advised() === 'FINE'" title="Fine - not an issue (F)" (click)="act($event, { kind: 'close', resolution: 'FINE' })">✓ <span class="bcc-w">Fine</span> <kbd>F</kbd></button>
            <button type="button" [class.advised]="advised() === 'NOT_IN_FLOW'" title="Not in this flow (N)" (click)="act($event, { kind: 'close', resolution: 'NOT_IN_FLOW' })">⊘ <span class="bcc-w">Not in flow</span> <kbd>N</kbd></button>
            <button type="button" [class.advised]="advised() === 'TO_DO'" title="To do (T)" (click)="act($event, { kind: 'move', status: 'TO_DO' })">→ <span class="bcc-w">To do</span> <kbd>T</kbd></button>
            @if (mergeAdvice(); as m) {
              <button type="button" class="advised" [title]="'Claude advises: ' + mergeText(m)" (click)="act($event, m)">⇢ <span class="bcc-w">{{ mergeText(m) }}</span></button>
            }
          }
          @if (card().status === 'CLOSED') {
            <button type="button" (click)="act($event, { kind: 'reopen' })">↺ Reopen</button>
          }
          @if (card().status === 'FIXED') {
            @if (retest()?.verdict === 'PASSES') {
              <button type="button" class="ok" title="Every call since the fix passes - move to Verified" (click)="act($event, { kind: 'move', status: 'VERIFIED' })">✓ Verified</button>
            }
            <button type="button" title="Record a re-test of this card - its steps show on the strip" (click)="act($event, { kind: 'retest' })">▶ Re-test</button>
          }
          @if (skill(); as cmd) {
            <span class="board-card-run bcc-run" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
              <app-run-skill [command]="cmd" [project]="card().project" [cycleId]="showCycle() ? null : card().cycleId" [cycleName]="cycleName()" [card]="card()" [editable]="editable()" />
            </span>
          }
        </div>
      }
    </div>
    } @else {
    <div class="board-card" [class.live-busy]="!!liveWork()" [class.selected]="selected()" [class.focused]="focused()" [class.closed]="card().status === 'CLOSED'"
         [class.blocked]="!!card().blockedBy?.length" [class.related]="!placement().own" [class.asks]="asks()" [attr.data-card]="card().id" tabindex="-1" (click)="onClick($event)"
         (mouseenter)="hovered.emit($any($event.currentTarget))" (mouseleave)="hovered.emit(null)">
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
      <div class="board-card-title" [appAutoDir]="card().title"><app-ref-text [text]="card().title" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></div>
      @if (toAzure(); as n) {
        <button type="button" class="tob-pill" title="Changes Claude prepared for Azure wait for your approval - open the card"
                (click)="$event.stopPropagation(); opened.emit()">⇪ {{ n }} to Azure</button>
      }
      @if (questionCount(); as n) {
        <button type="button" class="board-qpill" [disabled]="!editable()" [title]="editable() ? 'Answer the questions (A)' : 'Open questions from Claude'"
                (click)="$event.stopPropagation(); answer.emit()">❓ {{ n }} open question{{ n === 1 ? '' : 's' }}</button>
        <button type="button" class="board-qform" [disabled]="forms.busy()" title="This card's questions as an offline form - for someone outside Alfred"
                (click)="$event.stopPropagation(); questionsForm()">⇩ Form</button>
        @if (card().advice; as a) {
          <span class="board-advice" [title]="adviceTitle()">✦ advises: <bdi [appAutoDir]="a">{{ a }}</bdi>@if (confidence(); as cf) { <span class="board-conf" [class]="'board-conf board-conf-' + cf.toLowerCase()">{{ confidenceText(cf) }}</span> }</span>
          @if (card().adviceDetail?.reason; as why) {
            <div class="board-advice-why" [title]="why" [appAutoDir]="why"><b>Why:</b> <bdi><app-ref-text [text]="why" [project]="card().project" [cycleId]="card().cycleId" [showPreview]="false" /></bdi></div>
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
        <ng-container *ngTemplateOutlet="proposalBox; context: { $implicit: p }" />
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
    </div>
    }
    <!-- Claude's proposal, decided on the card itself; a click anywhere else on the card still opens it -->
    <ng-template #proposalBox let-p>
      <div class="board-prop" (click)="$event.stopPropagation()">
        <div class="board-prop-t">✦ Claude proposes {{ proposalText(p) }}</div>
        @if (p.reason) { <div class="board-prop-why" [appAutoDir]="p.reason">“{{ p.reason }}”</div> }
        @if (editable()) {
          <div class="board-prop-acts">
            <button type="button" class="ok" title="Take Claude's step as yours (P)" (click)="act($event, { kind: 'acceptProposal' })">✓ {{ acceptText(p) }} <kbd>P</kbd></button>
            <button type="button" title="Not now - the card goes back to Claude" (click)="act($event, { kind: 'dismissProposal' })">✕ Dismiss</button>
          </div>
        }
      </div>
    </ng-template>`,
})
export class BoardCardComponent {
  readonly card = input.required<CardSummary>();
  readonly forms = inject(QuestionsFormService);

  /** This card's open questions as a questions form (specs/037 D2). */
  questionsForm(): void {
    const c = this.card();
    void this.forms.download(c.boardId || defaultBoardId(c.project), [c.number]);
  }
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
  /** Compact: a few lines, the rest in the hover peek (the board's Compact / Comfortable switch). */
  readonly compact = input(false);
  /** The pointer came onto the card (its element) or left it (null): the board shows or hides the peek. */
  readonly hovered = output<HTMLElement | null>();
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
  readonly waiting = computed(() => waitingPill(this.card(), this.now(), userLabel(this.card().id)));
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

  /** Claude asks the user something - an open question or a Needs decision flag: the card pulses (never another Alfred's card). */
  readonly asks = computed(() => this.card().status !== 'CLOSED' && userLabel(this.card().id) === 'You'
    && (this.questionCount() > 0 || this.card().flags.includes('NEEDS_DECISION')));
  readonly kindLabel = computed(() => this.card().kind.charAt(0) + this.card().kind.slice(1).toLowerCase());
  readonly shortAge = computed(() => shortTime(this.age()));
  /** The waiting pill in a compact head: who and for how long ("you · 27m"); the full text is its tooltip. */
  readonly waitShort = computed(() => {
    const w = this.card().waiting;
    if (!w || w.who === 'NONE' || !this.waiting()) return null;
    const user = userLabel(this.card().id);
    const who = w.who === 'USER' ? (user === 'You' ? 'you' : user) : w.who === 'CLAUDE' ? 'Claude' : 're-test';
    return who + ' · ' + shortTime(ageText(w.since, this.now()));
  });
  /**
   * The one state a compact card shows, most urgent first: Claude working on it, its questions, the Fixed checks, the
   * re-test, a proposal, a block, a closed look-alike, changes for Azure, how it was closed, its Inbox rank.
   */
  private readonly states = computed(() => {
    const c = this.card();
    const out: CompactState[] = [];
    if (this.liveWork()) out.push('live');
    if (this.questionCount()) out.push('question');
    if (this.checks()) out.push('checks');
    else if (this.chip()) out.push('retest');
    if (c.blockedBy?.length) out.push('blocked');
    if (c.status === 'INBOX' && c.similarClosed) out.push('similar');
    if (this.toAzure()) out.push('azure');
    if (c.resolution) out.push('resolution');
    if (c.status === 'INBOX' && c.adviceDetail?.rank) out.push('rank');
    return out;
  });
  readonly primary = computed(() => this.states()[0] ?? null);
  /** How many more states the card has - the peek shows them all. */
  readonly extra = computed(() => Math.max(0, this.states().length - 1));
  /** The card's mentions counted by kind: ⇄3 ◆1 - every one of them is listed in the peek. */
  readonly mentionCounts = computed(() => {
    const by = new Map<string, number>();
    for (const m of this.card().mentionChips ?? []) {
      const t = mentionTypeOf(m);
      by.set(t, (by.get(t) ?? 0) + 1);
    }
    return [...by].map(([t, n]) => ({ icon: MENTION_ICONS[t as keyof typeof MENTION_ICONS] ?? '•', n, title: n + ' ' + t + (n === 1 ? '' : 's') }));
  });
  readonly hasActs = computed(() => this.editable() && (this.card().status === 'INBOX' || this.card().status === 'CLOSED' || this.card().status === 'FIXED'));

  flagIcon(f: Flag): string {
    return FLAG_ICONS[f] ?? '•';
  }
  readonly stale = computed(() => isStale(this.card(), this.now()));
  readonly age = computed(() => ageText(this.card().updatedAt, this.now()));
  // a card's task key is its board's id since specs/027 - name the board when it is one
  readonly cycleLabel = computed(() => {
    const id = this.card().cycleId;
    return this.cycleName() ?? (id ? this.boardNames().get(id) ?? id : '');
  });
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

  /** The Accept button names the step: "Close as Won't fix", "Merge into #11", "Verified". */
  acceptText(p: Proposal): string {
    const t = proposalText(p);
    return t.charAt(0).toUpperCase() + t.slice(1);
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

type CompactState = 'live' | 'question' | 'checks' | 'retest' | 'blocked' | 'similar' | 'azure' | 'resolution' | 'rank';

/** A flag as an icon, for a compact card too narrow for its words (the word stays the tooltip). */
const FLAG_ICONS: Record<Flag, string> = { URGENT: '⚡', RISK: '⚠', BLOCKER: '⛔', AFFECTS_PROJECT: '◎', NEEDS_DECISION: '⚖' };

/** "27 min" → "27m", "5 h" → "5h", "3 d" → "3d". */
export function shortTime(t: string): string {
  return t.replace(/^(\d+)\s*min$/, '$1m').replace(/^(\d+)\s*h$/, '$1h').replace(/^(\d+)\s*d$/, '$1d');
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
