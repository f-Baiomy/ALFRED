import { NgTemplateOutlet } from '@angular/common';
import { VerifyGuardService } from '../../../core/services/verify-guard.service';
import { Component, DestroyRef, ElementRef, HostListener, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import {
  ActivityEntry, CardDetail, CardKind, Proposal, CardStatus, FLAGS, FLAG_LABELS, Flag, KINDS, MentionRef, OPEN_STATUSES, RESOLUTION_LABELS,
  Resolution, SCOPE_LABELS, STATUS_LABELS, Scope, TextVersion,
} from '../../../core/models/board.models';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { TimelineFilter, after, dayLabel, isNewEntry } from '../../../shared/utils/timeline-view';
import { reactionsOf } from '../../../shared/utils/board-threads';
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
import { RefTextComponent } from '../mention-chip/ref-text.component';
import { shortOf } from '../../../shared/utils/readable-refs';
import { tap } from 'rxjs';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';
import { RunSkillComponent } from '../run-skill/run-skill.component';
import { RunHistoryComponent } from '../run-skill/run-history.component';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import { CardViewMode } from '../../../core/services/card-view-mode.service';
import { TeamsStateService } from '../../../core/state/teams-state.service';
import { ReturnPointService } from '../../../core/services/return-point.service';
import { SelectOption, SelectPickerComponent } from '../../select-picker/select-picker.component';
import { CardHomeComponent } from '../card-home/card-home.component';

import { BoardPagesComponent } from '../visuals/board-pages.component';
import { BoardFilesComponent } from '../visuals/board-files.component';
import { BoardPinnedComponent } from '../visuals/board-pinned.component';
import { QuickAnswerComponent } from '../quick-answer/quick-answer.component';
import { TeamCardItemsComponent } from '../../team/card-items/card-items.component';
import { TeamCardOwnerComponent } from '../../team/card-owner/card-owner.component';
import { TeamApiService } from '../../../core/team/team-api.service';
import { CardItem } from '../../../core/team/team.models';

export type CardTab = 'activity' | 'details' | 'links' | 'retest';
/** The card before and after this one in its column (the drawer's ‹ › and [ ]). */
export interface CardSiblings {
  readonly prev: string | null;
  readonly next: string | null;
  readonly index: number;
  readonly total: number;
  readonly column: string;
}
type Verdict = { readonly text: string; readonly tone: 'pass' | 'fail' | 'part' | 'wait' };

const SECTIONS_KEY = 'alfred.card.sections';
const DENSE_KEY = 'alfred.card.dense';
/** Cycle names already looked up, for every card the drawer opens. */
const cycleNames = new Map<string, string>();
const JOURNEY: readonly CardStatus[] = ['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'DONE'];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // a viewer convenience: without storage the choice lasts until the page reloads
  }
}

/**
 * One card opened (FR-027..029; layout specs/023): a header (the bar, the title, the property chips and the card's
 * journey) that shrinks to one line on scroll; "Needs you" for what waits on the user; then Activity · Details · Links ·
 * Re-test as tabs in the side panel, or a main column and a rail in Full/Window. Sections fold by what the card holds;
 * the user's own choice per section is kept in this browser. Re-reads itself whenever the board says this card changed
 * (`version`).
 */
@Component({
  selector: 'app-card-drawer',
  standalone: true,
  imports: [TeamCardItemsComponent, TeamCardOwnerComponent, CardHomeComponent, BoardPagesComponent, BoardFilesComponent, BoardPinnedComponent, NgTemplateOutlet, SelectPickerComponent, ActivityTimelineComponent, CardRetestComponent, LiveWorkBoxComponent, MarkdownViewComponent, MentionChipComponent, RefTextComponent, MentionEditorComponent, MentionPickerComponent, RunSkillComponent, RunHistoryComponent, QuickAnswerComponent],
  template: `
    <ng-template #modeSwitch>
      <div class="board-seg board-drawer-modes cd-modes" role="group" aria-label="Show the card as">
        @for (m of modes; track m.mode) {
          <button type="button" [class.on]="layout() === m.mode" [title]="m.title" [attr.aria-label]="m.title" (click)="layout() !== m.mode && modeChange.emit(m.mode)">{{ m.icon }}</button>
        }
      </div>
    </ng-template>
    <aside class="board-drawer" [class.board-drawer-full]="layout() !== 'side'" [class.board-drawer-window]="layout() === 'window'"
           [class.cd-dense]="dense()" role="dialog" aria-label="Card">
      @if (card(); as c) {
        <div class="board-drawer-head cd-head" [class.cd-mini]="collapsed()" [class.cd-peek]="peek()">
          <div class="cd-minibar" [hidden]="!collapsed()">
            <div class="cd-bar">
              <button type="button" class="cd-num" title="Copy #{{ c.number }}" (click)="copyNumber()">{{ copied() === 'num' ? '✓' : '#' + c.number }}</button>
              <b class="cd-mini-title" [title]="'Show the whole header - ' + c.title" (click)="openPeek()">{{ c.title }}</b>
              <button type="button" class="cd-ib" title="Show the whole header here, without scrolling up" (click)="openPeek()">▾</button>
              <span class="cd-st" [class]="'cd-st cd-st-' + c.status">{{ statusText(c) }}</span>
              @if (needs(); as n) { @if (n.rows.length) { <button type="button" class="cd-needs-pill" title="Show what needs you" (click)="openPeek()">⚠ {{ n.summary }}</button> } }
              @if (skill()) { <button type="button" class="cd-ib" title="Run the next step (R)" (click)="runSkill()?.go()">▶</button> }
              <ng-container *ngTemplateOutlet="moreMenu" />
              <button type="button" class="board-drawer-x cd-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
            </div>
          </div>
          <!-- kept alive while the header is shrunk: its ▶ (and R) must keep working -->
          <div [hidden]="collapsed()">
            <div class="cd-bar">
              <button type="button" class="cd-num" title="Copy #{{ c.number }}" (click)="copyNumber()">{{ copied() === 'num' ? '✓ copied' : '#' + c.number }}</button>
              <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span>
              @if (c.author === 'CLAUDE') { <span class="board-ai" title="Found by Claude">✦ Claude</span> }
              @if (c.cycleId) { <span class="cd-cycle" [title]="'Cycle ' + c.cycleId">◷ {{ c.cycleDeleted ? 'cycle deleted' : cycleName() ?? c.cycleId.slice(0, 8) }}</span> }
              @if (waiting(); as w) { <span class="board-wait" [class]="'board-wait board-wait-' + c.waiting!.who">{{ w }}</span> }
              @if (c.openQuestions; as n) {
                <button type="button" class="board-qpill" [disabled]="!editable()" title="Claude's open questions - answer them in one go"
                        (click)="answering.set(true)">❓ {{ n }}</button>
              }
              <span class="cd-grow"></span>
              @if (skill(); as cmd) {
                <app-run-skill #runSkill [command]="cmd" [project]="c.project" [cycleId]="inCycle() ? c.cycleId : null" [card]="c" [lastUserWord]="lastUserWord()"
                               [editable]="editable()" />
              }
              <ng-container *ngTemplateOutlet="moreMenu" />
              @if (siblings(); as s) {
                <span class="cd-pager" [title]="'Card ' + (s.index + 1) + ' of ' + s.total + ' in ' + s.column">
                  <button type="button" [disabled]="!s.prev" title="Previous card ([)" (click)="stepTo(s.prev)">‹</button>
                  <button type="button" [disabled]="!s.next" title="Next card (])" (click)="stepTo(s.next)">›</button>
                </span>
              }
              <ng-container *ngTemplateOutlet="modeSwitch" />
              @if (peek()) { <button type="button" class="cd-ib" title="Shrink the header again" (click)="closePeek()">▴</button> }
              <button type="button" class="board-drawer-x cd-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
            </div>
            @if (editingTitle()) {
              <input #title class="board-drawer-title-input" type="text" maxlength="300" [value]="c.title"
                     (keydown.enter)="saveTitle(title.value)" (keydown.escape)="editingTitle.set(false)" (blur)="saveTitle(title.value)" />
            } @else {
              <h2 class="board-drawer-title cd-title" [title]="editable() ? 'Click to rename' : ''" (click)="editable() && editingTitle.set(true)"><app-ref-text [text]="c.title" [project]="c.project" [cycleId]="c.cycleId" /></h2>
            }
            <div class="board-drawer-short cd-short" title="What every mention of this card reads: “{{ shortNameOf(c) }} (#{{ c.number }})”">
              @if (editingShort()) {
                <input #short class="board-drawer-short-input" type="text" maxlength="60" [value]="c.shortName ?? ''" placeholder="a few words"
                       (keydown.enter)="saveShortName(short.value)" (keydown.escape)="editingShort.set(false)" (blur)="saveShortName(short.value)" />
              } @else {
                <span class="board-dim">Mentioned as&nbsp;</span><b>{{ shortNameOf(c) }} (#{{ c.number }})</b>
                @if (!c.shortName) { <span class="board-dim">&nbsp;· from the title</span> }
                @if (editable()) { <button type="button" class="board-link cd-hover-only" (click)="editingShort.set(true)">✎ short name</button> }
              }
            </div>
            <app-card-home [card]="c" [editable]="editable()" />
            <div class="cd-props">
              <span class="cd-prop" [class]="'cd-prop cd-prop-' + c.status"><span class="cd-k">Status</span>
                <app-select-picker class="select-compact" [disabled]="!editable()" [options]="statusOptions" [value]="statusValue()"
                                   ariaLabel="Status" (valueChange)="changeStatus($event)" /></span>
              <span class="cd-prop"><span class="cd-k">Kind</span>
                <app-select-picker class="select-compact" [disabled]="!editable()" [options]="kindOptions" [value]="c.kind"
                                   ariaLabel="Kind" (valueChange)="save({ kind: $any($event) })" /></span>
              <span class="cd-prop" [class.cd-quiet]="c.scope === 'NOT_DECIDED'"><span class="cd-k">Scope</span>
                <app-select-picker class="select-compact" [disabled]="!editable()" [options]="scopeOptions" [value]="c.scope"
                                   ariaLabel="Scope" (valueChange)="save({ scope: $any($event) })" /></span>
              @for (f of c.flags; track f) {
                <button type="button" class="cd-flag" [class]="'cd-flag board-flag-' + f" [disabled]="!editable()" [title]="editable() ? 'Click to take the flag off' : flagLabels[f]"
                        (click)="toggleFlag(f)">{{ flagLabels[f] }}</button>
              }
              @if (editable()) {
                <span class="board-editor-dd">
                  <button type="button" class="cd-prop cd-dash" title="Flags" [attr.aria-expanded]="menuOpen() === 'flags'" (click)="toggleMenu('flags')">⚑{{ c.flags.length ? '' : ' flag' }} +</button>
                  @if (menuOpen() === 'flags') {
                    <span class="board-editor-dd-menu cd-menu">
                      @for (f of flags; track f) {
                        <button type="button" class="board-editor-swatch" (click)="toggleFlag(f)"><span class="cd-chk">{{ c.flags.includes(f) ? '✓' : '' }}</span>{{ flagLabels[f] }}</button>
                      }
                    </span>
                  }
                </span>
              }
              @for (t of cardTeams(); track t.id) {
                <span class="board-team" [style.--team]="t.color" [title]="t.owns">
                  @if (t.icon) { <span aria-hidden="true">{{ t.icon }}</span> }{{ t.name }}
                  @if (editable()) { <button type="button" class="board-team-x" [attr.aria-label]="'Remove ' + t.name" (click)="removeTeam(t.id)">✕</button> }
                </span>
              }
              @if (editable() && otherTeams().length) {
                <app-select-picker class="board-team-add" [options]="teamOptions()" value="" placeholder="+ team" ariaLabel="Add a team"
                                   (valueChange)="addTeam($event)" />
              }
              <app-team-card-owner [cardId]="c.id" [editable]="editable()" />
            </div>
            <div class="cd-journey" aria-label="Where the card is">
              @for (j of journey(); track j.status; let first = $first) {
                @if (!first) { <span class="cd-j-arrow" aria-hidden="true">›</span> }
                <button type="button" class="cd-j" [class.done]="j.state === 'done'" [class.now]="j.state === 'now'" [class.proposed]="j.proposed"
                        [disabled]="!editable() || j.state === 'now' || j.status === 'CLOSED'" [title]="j.title" (click)="changeStatus(j.status)">
                  {{ j.state === 'done' ? '✓ ' : j.state === 'now' ? '● ' : '' }}{{ j.label }}@if (j.state === 'now' && j.at) {<small> {{ j.at }}</small>}@if (j.proposed) {<small> ✦ proposed</small>}</button>
              }
            </div>
            @if (peek()) { <div class="cd-peek-needs"><ng-container *ngTemplateOutlet="needsPart" /></div> }
          </div>
        </div>
        <div class="board-drawer-body cd-body" (scroll)="onScroll($event)">
          <ng-container *ngTemplateOutlet="needsPart" />
          <!-- tabs in every view: full screen and the window get the same tabs, using their whole width -->
            <nav class="cd-tabs" role="tablist" aria-label="Card sections">
              <button type="button" role="tab" [class.on]="tab() === 'activity'" [attr.aria-selected]="tab() === 'activity'" title="Activity (Shift+1)" (click)="showTab('activity')">
                Activity<span class="cd-n">{{ activityTotal() }}</span>@if (newCount()) {<span class="cd-dot" title="New since you looked"></span>}</button>
              <button type="button" role="tab" [class.on]="tab() === 'details'" [attr.aria-selected]="tab() === 'details'" title="Details (Shift+2)" (click)="showTab('details')">
                Details@if (descriptionChanged()) {<span class="cd-dot" title="The description changed since you looked"></span>}</button>
              <button type="button" role="tab" [class.on]="tab() === 'links'" [attr.aria-selected]="tab() === 'links'" title="Links (Shift+3)" (click)="showTab('links')">
                {{ openBlockers().length ? '🔒 ' : '' }}Links<span class="cd-n">{{ linkCount() }}</span></button>
              @if (retestShown()) {
                <button type="button" role="tab" [class.on]="tab() === 'retest'" [attr.aria-selected]="tab() === 'retest'" title="Re-test (Shift+4)" (click)="showTab('retest')">
                  Re-test@if (verdict(); as v) {<span class="cd-n" [class]="'cd-n cd-v-' + v.tone">{{ verdictShort(v) }}</span>}</button>
              }
            </nav>
            <div class="cd-panel">
              @switch (tab()) {
                @case ('activity') { <ng-container *ngTemplateOutlet="activityPart" /> }
                @case ('details') { <ng-container *ngTemplateOutlet="detailsPart" /> }
                @case ('links') { <ng-container *ngTemplateOutlet="linksPart" /> }
              }
              <!-- kept rendered off its tab: its verdict names the tab and the "needs you" row -->
              @if (retestShown()) { <div [hidden]="tab() !== 'retest'"><ng-container *ngTemplateOutlet="retestPart" /></div> }
            </div>
        </div>
        @if (editable()) {
          <div class="board-drawer-composer cd-composer">
            @if (quickReplies(); as q) {
              <div class="cd-quick" aria-label="Quick replies">
                <span class="board-dim">Quick reply:</span>
                @if (q.goAhead) { <button type="button" class="cd-qr" title="✅ on Claude's latest comment - your go-ahead" (click)="goAhead()">✅ Go ahead</button> }
                @if (c.openQuestions; as n) { <button type="button" class="cd-qr" (click)="answering.set(true)">❓ Answer the {{ n === 1 ? 'question' : n + ' questions' }}</button> }
                @if (q.replyTo !== null) {
                  <button type="button" class="cd-qr" (click)="quickReply('Explain more, please.')">Explain more</button>
                  <button type="button" class="cd-qr" (click)="quickReply('Not now.')">Not now</button>
                }
              </div>
            }
            <app-mention-editor #composer [value]="draft()" (valueChange)="draft.set($event)" [project]="c.project" [cycleId]="c.cycleId" [compact]="true" [rows]="1"
                                placeholder="Write a comment… @ to mention, / for blocks" [contextMentions]="c.links" [card]="pickTarget()" pickField="comment"
                                [attach]="{ card: c.id }" [draftKey]="'comment:' + c.id" (submitted)="comment($event)" />
            @if (teamItems().length && editable()) {
              <label class="cd-also" title="Your own comment - posted to each linked item at once, with the via Alfred footer">
                <input type="checkbox" [checked]="alsoTracker()" (change)="alsoTracker.set($any($event.target).checked)" />
                Also post to {{ teamItems().length === 1 ? teamItems()[0].item : teamItems().length + ' linked items' }}</label>
            }
          </div>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
        @if (answering()) { <app-quick-answer [cardId]="c.id" (closed)="answering.set(false); load(c.id)" /> }
        @if (keysOpen()) {
          <div class="run-dialog-bg dialog-backdrop" (click)="keysOpen.set(false)">
            <div class="run-dialog cd-keys" role="dialog" aria-label="Keyboard shortcuts" (click)="$event.stopPropagation()">
              <div class="run-dialog-head"><b>Keys while a card is open</b><button type="button" class="board-link" (click)="keysOpen.set(false)">✕</button></div>
              <div class="cd-keys-grid">
                <kbd>Shift</kbd><span>+ <kbd>1</kbd>–<kbd>4</kbd> Activity · Details · Links · Re-test</span>
                <span><kbd>[</kbd> <kbd>]</kbd></span><span>previous / next card in the column</span>
                <kbd>/</kbd><span>write a comment</span>
                <kbd>E</kbd><span>edit the description</span>
                <span><kbd>R</kbd> <kbd>C</kbd> <kbd>⇧R</kbd></span><span>run · copy the prompt · edit the prompt</span>
                <kbd>Shift+F</kbd><span>side / full screen</span>
                <kbd>?</kbd><span>this list</span>
                <kbd>Esc</kbd><span>close</span>
              </div>
            </div>
          </div>
        }
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

        <ng-template #needsPart>
          @if (card(); as c) { @if (needs(); as n) {
            <section class="cd-sec cd-needs" [class.cd-attn]="n.rows.length" [class.closed]="!isOpen('needs', n.rows.length > 0)">
              <button type="button" class="cd-sh" (click)="toggleSection('needs', n.rows.length > 0)">
                <span class="cd-car">▾</span><h5>{{ n.rows.length ? 'Needs you' : 'Notes' }}</h5><span class="cd-smry">{{ n.summary }}</span></button>
              @if (isOpen('needs', n.rows.length > 0)) {
                <div class="cd-sb">
                  @if (c.proposal; as p) {
                    <div class="cd-row" role="group" aria-label="Claude's proposal">
                      <span class="cd-ico board-ai">✦</span>
                      <span class="cd-row-text"><b>Claude proposes: {{ proposalText(p) }}</b>
                        @if (p.reason) { <span class="board-dim"> - “<app-ref-text [text]="p.reason" [project]="c.project" [cycleId]="c.cycleId" [card]="c.number" />”</span> }
                        @if (p.evidence) { <button type="button" class="board-link" (click)="showEvidence.set(!showEvidence())">{{ showEvidence() ? 'hide evidence' : 'evidence' }}</button> }</span>
                      <button type="button" class="action-btn primary" [disabled]="!editable()" (click)="acceptProposal()">Accept</button>
                      <button type="button" class="action-btn" [disabled]="!editable()" (click)="dismissProposal()">Dismiss</button>
                    </div>
                    @if (showEvidence() && p.evidence) { <app-markdown-view class="board-proposal-evidence cd-evidence" [text]="p.evidence" /> }
                  }
                  @if (c.openQuestions; as q) {
                    <div class="cd-row"><span class="cd-ico cd-amber">❓</span>
                      <span class="cd-row-text"><b>{{ q }} open question{{ q === 1 ? '' : 's' }}</b> <span class="board-dim">from Claude</span></span>
                      <button type="button" class="action-btn" [disabled]="!editable()" (click)="answering.set(true)">Answer</button></div>
                  }
                  @for (b of openBlockers(); track b.number) {
                    <div class="cd-row"><span class="cd-ico cd-red">🔒</span>
                      <span class="cd-row-text"><b>Blocked by #{{ b.number }}</b> <span class="board-dim">{{ b.title }} · {{ statusLabels[b.status] }}</span></span>
                      <button type="button" class="action-btn" (click)="showTab('links')">Links</button></div>
                  }
                  @if (retestFailing(); as v) {
                    <div class="cd-row"><span class="cd-ico cd-red">✗</span><span class="cd-row-text"><b>Re-test</b> <span class="board-dim">{{ v.text }}</span></span>
                      <button type="button" class="action-btn" (click)="showTab('retest')">See it</button></div>
                  }
                  @if (n.notes) {
                    @if (n.rows.length && !notesOpen()) {
                      <button type="button" class="cd-row cd-notes-line" (click)="notesOpen.set(true)">▸ {{ n.notes }} note{{ n.notes === 1 ? '' : 's' }} · {{ n.notesSummary }}</button>
                    } @else {
                      @if (c.similarClosed; as s) { <div class="cd-row board-sim"><span class="cd-ico cd-amber">⚠</span><span class="cd-row-text">Looks like #{{ s.number }}, closed as {{ resolutionLabels[s.resolution] }}{{ s.reason ? ': ' + s.reason : '' }}</span></div> }
                      @if (c.reason) { <div class="cd-row board-card-reason"><span class="cd-ico board-dim">❝</span><span class="cd-row-text board-dim">Reason: “<app-ref-text [text]="c.reason" [project]="c.project" [cycleId]="c.cycleId" [card]="c.number" />”</span></div> }
                    }
                  }
                </div>
              }
            </section>
          } }
        </ng-template>
        <ng-template #moreMenu>
          <span class="board-editor-dd">
            <button type="button" class="cd-ib" title="More" aria-label="More" [attr.aria-expanded]="menuOpen() === 'more'" (click)="toggleMenu('more')">⋯</button>
            @if (menuOpen() === 'more') {
              <span class="board-editor-dd-menu cd-menu cd-menu-r">
                <button type="button" class="board-editor-swatch" title="Copy the card as Markdown for Jira / GitHub" (click)="copyIssue(); menuOpen.set(null)">{{ copied() === 'issue' ? '✓ copied' : '⧉ Copy as issue' }}</button>
                @if (c.cycleId) { <button type="button" class="board-editor-swatch" (click)="copyCycleId()">⧉ Copy cycle id</button> }
                <button type="button" class="board-editor-swatch" (click)="setAllSections(true)">⇲ Expand all sections</button>
                <button type="button" class="board-editor-swatch" (click)="setAllSections(false)">⇱ Fold all sections</button>
                <button type="button" class="board-editor-swatch" (click)="toggleDense()"><span class="cd-chk">{{ dense() ? '✓' : '' }}</span>Compact spacing</button>
                <button type="button" class="board-editor-swatch" (click)="keysOpen.set(true); menuOpen.set(null)">⌨ Keyboard shortcuts <span class="board-dim">?</span></button>
                @if (editable()) { <button type="button" class="board-editor-swatch cd-danger" (click)="menuOpen.set(null); remove()">🗑 Delete card…</button> }
              </span>
            }
          </span>
        </ng-template>

        <ng-template #activityPart>
          <div class="cd-afilter">
            @if (searching()) {
              <input #find class="cd-find" type="search" placeholder="Find in this card's activity…" [value]="query()" (input)="query.set(find.value)"
                     (keydown.escape)="closeFind()" aria-label="Find in the activity" />
            } @else {
              @for (f of filters; track f.value) {
                <button type="button" class="cd-fb" [class.on]="filter() === f.value" (click)="filter.set(f.value)">{{ f.label }}</button>
              }
            }
            <span class="cd-grow"></span>
            <button type="button" class="cd-ib" title="Open every reply" (click)="tl.openAll()">⊞</button>
            <button type="button" class="cd-ib" title="Fold every reply (as the card opens)" (click)="tl.foldAll()">⊟</button>
            <button type="button" class="cd-ib" [class.on]="searching()" title="Find in the activity" (click)="searching() ? closeFind() : openFind()">🔍</button>
            <button type="button" class="cd-ib" [class.on]="newestFirst()" [title]="newestFirst() ? 'Newest first - click for oldest first' : 'Oldest first - click for newest first'" (click)="newestFirst.set(!newestFirst())">⇅</button>
          </div>
          <app-activity-timeline #tl [entries]="activity()" [editable]="editable()" [project]="c.project" [cycleId]="c.cycleId"
                                 [card]="pickTarget()" [filter]="filter()" [newestFirst]="newestFirst()" [query]="query()" [newSince]="newSince()"
                                 (replied)="reply($event)" (answerQuestions)="answering.set(true)" />
          <app-live-work-box [project]="c.project" [number]="c.number" [editable]="editable()" />
          @if (awayFromLatest()) {
            <button type="button" class="cd-latest" (click)="scrollToLatest('smooth')">↓ Latest{{ newCount() ? ' · ' + newCount() + ' new' : '' }}</button>
          }
          <section class="cd-sec cd-runs" [class.closed]="!isOpen('runs', false)">
            <button type="button" class="cd-sh" (click)="toggleSection('runs', false)"><span class="cd-car">▾</span><h5>Runs</h5><span class="cd-smry">the skills run on this card</span></button>
            @if (isOpen('runs', false)) { <div class="cd-sb"><app-run-history [project]="c.project" [number]="c.number" /></div> }
          </section>
        </ng-template>

        <ng-template #detailsPart>
          <section class="cd-sec board-drawer-desc" [class.closed]="!isOpen('desc', true)">
            <div class="cd-sh" role="button" tabindex="0" (click)="toggleSection('desc', true)" (keydown.enter)="toggleSection('desc', true)">
              <span class="cd-car">▾</span><h5>Description</h5><span class="cd-smry">{{ descSummary() }}</span>
              <span class="cd-sacts" (click)="$event.stopPropagation()">
                @if (editable() && !editingDescription()) { <button type="button" class="cd-ib" title="Edit the description (E)" (click)="editDescription()">✎</button> }
                @if (descriptionEdited()) { <button type="button" class="cd-ib" title="See the earlier descriptions" (click)="showDescriptionHistory(c)">🕘</button> }
              </span>
            </div>
            @if (isOpen('desc', true)) {
              <div class="cd-sb">
                @if (editingDescription()) {
                  <app-mention-editor [value]="descriptionDraft() ?? c.description" [project]="c.project" [cycleId]="c.cycleId" [contextMentions]="c.links"
                                      [card]="pickTarget()" pickField="description" [attach]="{ card: c.id }"
                                      submitLabel="Save" [cancellable]="true" [allowEmpty]="true" [rows]="8" [enterSends]="false" [draftKey]="'desc:' + c.id"
                                      (submitted)="saveDescription($event)" (cancelled)="editingDescription.set(false); descriptionDraft.set(null)" />
                } @else {
                  <div class="board-desc cd-desc" [class.cd-clamp]="longDescription() && !descOpen()" (dblclick)="editable() && editDescription()">
                    <app-markdown-view [text]="c.description" empty="No description yet." [idPrefix]="'card-' + c.id + '-'" [outline]="true"
                      [snippetOwner]="'inline:card:' + c.id + ':desc'" [snippetContext]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" /></div>
                  @if (longDescription()) { <button type="button" class="board-link" (click)="descOpen.set(!descOpen())">{{ descOpen() ? 'Show less' : 'Read all' }}</button> }
                }
              </div>
            }
          </section>
          <section class="cd-sec" [class.closed]="!isOpen('att', true)">
            <button type="button" class="cd-sh" (click)="toggleSection('att', true)"><span class="cd-car">▾</span><h5>Attached</h5><span class="cd-smry">pinned items, pages and files</span></button>
            @if (isOpen('att', true)) {
              <div class="cd-sb cd-attached">
                <app-board-pinned [owner]="'card:' + c.id" [canEdit]="editable()" [context]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" />
                <app-board-pages [owner]="'card:' + c.id" [canEdit]="editable()" [context]="{ card: c.number, cardId: c.id, project: c.project, cycleId: c.cycleId }" />
                <app-board-files [card]="c.id" [canEdit]="editable()" />
              </div>
            }
          </section>
        </ng-template>

        <ng-template #linksPart>
          <div class="cd-links">
            <app-team-card-items [cardId]="c.id" [cardTitle]="c.title" [cardDescription]="c.description" [editable]="editable()"
                                 (linked)="teamItems.set($event)" />
            <div class="cd-lh"><h5>Linked <span class="board-dim">from mentions</span></h5>
              @if (editable()) { <button type="button" class="board-link" (click)="linking.set(!linking())">+ link</button> }</div>
            @if (linking()) {
              <app-mention-picker [project]="c.project" [cycleId]="c.cycleId" [calls]="callLinks()" [canPickAnywhere]="true"
                                (pickAnywhere)="pickLinksFromAnywhere()" (picked)="addLink($event)" (closed)="linking.set(false)" />
            }
            <div class="board-links">
              @for (m of c.links; track m.type + m.ref) { <app-mention-chip [mention]="m" /> } @empty { <span class="board-dim">Nothing linked.</span> }
            </div>
            @if (c.specItems?.length) {
              <div class="cd-lh"><h5>Breaks the spec</h5></div>
              @for (i of c.specItems; track i.fileName + i.itemKey) {
                <div class="board-spec-item">📄 {{ i.fileName }} · {{ i.text ?? '(item removed from the spec)' }}</div>
              }
            }
            <div class="cd-lh"><h5>Blocked by</h5>
              @if (editable()) { <button type="button" class="board-link" (click)="blocking.set(!blocking())">+ blocked by…</button> }</div>
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
          </div>
        </ng-template>

        <ng-template #retestPart>
          <app-card-retest class="board-drawer-retest" [card]="c" [version]="version()" [editable]="editable()" (retest)="retestRequested.emit(c.number)"
                           (verdict)="verdict.set($event)" />
        </ng-template>
      } @else {
        <div class="board-drawer-head"><button type="button" class="board-drawer-x" (click)="closed.emit()">✕</button>
          <ng-container *ngTemplateOutlet="modeSwitch" />
          <span class="board-dim">{{ error() ?? 'Loading…' }}</span></div>
      }
    </aside>`,

})
export class CardDrawerComponent {
  private readonly api = inject(BoardApiService);
  private readonly teamApi = inject(TeamApiService);
  /** The card's linked work items (from "Linked in …") and whether a comment also goes to them. */
  readonly teamItems = signal<CardItem[]>([]);
  readonly alsoTracker = signal(false);
  private readonly teamReset = effect(() => {
    this.card()?.id;
    untracked(() => {
      this.teamItems.set([]);
      this.alsoTracker.set(false);
    });
  });
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
  /** ‹ › in the header: the cards around this one in its column (none: no pager). */
  readonly siblings = input<CardSiblings | null>(null);
  /** Open another card in the drawer (‹ ›, [ ]). */
  readonly step = output<string>();

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
  readonly editingShort = signal(false);
  readonly editingDescription = signal(false);
  readonly linking = signal(false);
  readonly blocking = signal(false);
  readonly copied = signal<'cmd' | 'issue' | 'num' | 'cycle' | null>(null);
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
    if (event.key === 'Escape' && this.keysOpen()) {
      this.keysOpen.set(false);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('.dialog-backdrop, .run-dialog-bg')) return;
    if (this.cardKeys(event)) {
      event.preventDefault();
      return;
    }
    const run = this.runSkill();
    if (!run) return;
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

  readonly modes: readonly { mode: CardViewMode; icon: string; title: string }[] = [
    { mode: 'side', icon: '▐', title: 'Side panel - the board stays visible (Shift+F)' },
    { mode: 'full', icon: '⛶', title: 'Full screen - use the whole page (Shift+F)' },
    { mode: 'window', icon: '↗', title: 'Open in its own window' },
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

  // ------------------------------------------------------------------------------------------------ specs/023 layout
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly composer = viewChild<{ focus(): void }>('composer');
  private readonly timeline = viewChild<ActivityTimelineComponent>('tl');

  readonly cycleName = signal<string | null>(null);
  /** The tab the user picked (null: the smart one - Activity when there is a conversation, else Details). */
  private readonly pickedTab = signal<CardTab | null>(null);
  readonly tab = computed<CardTab>(() => {
    const picked = this.pickedTab();
    if (picked && (picked !== 'retest' || this.retestShown())) return picked;
    return this.activity().some((e) => e.kind === 'COMMENT') ? 'activity' : 'details';
  });
  readonly filters: readonly { value: TimelineFilter; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'comments', label: 'Comments' }, { value: 'changes', label: 'Changes' },
  ];
  readonly filter = signal<TimelineFilter>('all');
  readonly newestFirst = signal(false);
  readonly searching = signal(false);
  readonly query = signal('');
  /** When the user last looked at this card before now (read before it is marked seen); null: nothing is new. */
  readonly newSince = signal<string | null>(null);
  private loadedId: string | null = null;
  /** The card just opened: once its activity is drawn, scroll to the first new comment or the latest. */
  private landOnLatest = false;
  readonly verdict = signal<Verdict | null>(null);
  /** The header shrinks to one line once the body is scrolled. */
  readonly mini = signal(false);
  /** The shrunk header opened in place (specs/023): the whole header and "Needs you" without scrolling the activity up. */
  readonly peek = signal(false);
  readonly collapsed = computed(() => this.mini() && !this.peek());
  /** Where the body was when the header opened in place; scrolling on from there shrinks it again. Null until drawn. */
  private peekAt: number | null = null;
  readonly dense = signal(readJson<boolean>(DENSE_KEY, false));
  readonly keysOpen = signal(false);
  readonly menuOpen = signal<'more' | 'flags' | null>(null);
  readonly showEvidence = signal(false);
  readonly notesOpen = signal(false);
  readonly descOpen = signal(false);
  /** Sections the user opened or folded (id → open), kept in this browser; the rest follow the card. */
  private readonly sections = signal<Readonly<Record<string, boolean>>>(readJson<Record<string, boolean>>(SECTIONS_KEY, {}));

  isOpen(id: string, smart: boolean): boolean {
    return this.sections()[this.sectionKey(id)] ?? smart;
  }

  /** "Needs you" is remembered per card (folding it once must not hide the next card's proposal); the rest per browser. */
  private sectionKey(id: string): string {
    return id === 'needs' ? `needs:${this.card()?.id ?? ''}` : id;
  }

  toggleSection(id: string, smart: boolean): void {
    this.setSection(id, !this.isOpen(id, smart));
  }

  private setSection(id: string, open: boolean): void {
    const next = { ...this.sections(), [this.sectionKey(id)]: open };
    this.sections.set(next);
    writeJson(SECTIONS_KEY, next);
  }

  setAllSections(open: boolean): void {
    this.menuOpen.set(null);
    const kept = Object.fromEntries(Object.entries(this.sections()).filter(([k]) => k.startsWith('needs:') && k !== this.sectionKey('needs')));
    const next = { ...kept, ...Object.fromEntries(['needs', 'desc', 'att', 'runs'].map((k) => [this.sectionKey(k), open])) };
    this.sections.set(next);
    writeJson(SECTIONS_KEY, next);
  }

  toggleDense(): void {
    this.menuOpen.set(null);
    this.dense.set(!this.dense());
    writeJson(DENSE_KEY, this.dense());
  }

  toggleMenu(which: 'more' | 'flags'): void {
    this.menuOpen.set(this.menuOpen() === which ? null : which);
  }

  @HostListener('document:click', ['$event'])
  closeMenus(event: MouseEvent): void {
    if (this.menuOpen() && !(event.target as HTMLElement | null)?.closest('.board-editor-dd')) this.menuOpen.set(null);
  }

  showTab(tab: CardTab): void {
    this.pickedTab.set(tab);
    this.mini.set(false);
    if (tab === 'activity') this.afterRender(() => this.scrollToLatest('open'));
  }

  /** The user scrolled up far from the latest - a "↓ Latest" button brings them back (as in a chat). */
  readonly awayFromLatest = signal(false);
  private revealing = false;
  private readonly injector = inject(Injector);

  private body(): HTMLElement | null {
    return (this.host.nativeElement as HTMLElement).querySelector('.cd-body');
  }

  private afterRender(fn: () => void): void {
    afterNextRender(fn, { injector: this.injector });
  }

  /**
   * Activity opens like a chat (specs/023): `open` lands on the first comment that is new since the user looked, else
   * the latest; `bottom` stays at the latest as answers arrive; `smooth` is the "↓ Latest" button.
   */
  scrollToLatest(how: 'open' | 'bottom' | 'smooth', retry = true): void {
    const body = this.body();
    if (!body && retry) {
      // the card itself is not drawn yet (its answer came after the activity's): once more after the next render
      this.afterRender(() => this.scrollToLatest(how, false));
      return;
    }
    if (!body || this.tab() !== 'activity') return;
    const smooth = how === 'smooth';
    const fresh = how === 'open' ? body.querySelector('.cd-timeline [data-new]') as HTMLElement | null : null;
    if (smooth) {
      body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
      return;
    }
    // comments finish drawing (snippets, pictures) over the next frames: keep the place until they have
    this.settle(() => {
      if (fresh?.isConnected) {
        const tabs = body.querySelector('.cd-tabs') as HTMLElement | null;
        body.scrollTop += fresh.getBoundingClientRect().top - body.getBoundingClientRect().top - (tabs?.offsetHeight ?? 0) - 12;
      } else {
        body.scrollTop = body.scrollHeight;
      }
    });
  }

  /**
   * Runs `fix` every frame for a moment (700 ms) - stopped at once by the user's own wheel, touch or key - then `done`.
   * Not a timer that polls anything: it ends by itself and only re-places what was just drawn.
   */
  private settle(fix: () => void, done: () => void = () => undefined): void {
    const body = this.body();
    let stop = false;
    const quit = () => { stop = true; };
    body?.addEventListener('wheel', quit, { once: true, passive: true });
    body?.addEventListener('touchstart', quit, { once: true, passive: true });
    body?.addEventListener('keydown', quit, { once: true });
    const end = performance.now() + 700;
    const step = () => {
      if (!stop) fix();
      if (!stop && performance.now() < end) requestAnimationFrame(step);
      else {
        body?.removeEventListener('wheel', quit);
        body?.removeEventListener('touchstart', quit);
        body?.removeEventListener('keydown', quit);
        done();
      }
    };
    step();
  }

  private nearLatest(): boolean {
    const body = this.body();
    return !body || body.scrollHeight - body.scrollTop - body.clientHeight < 160;
  }

  onScroll(event: Event): void {
    const body = event.target as HTMLElement;
    const top = body.scrollTop;
    // a band between the two, and only with room to spare: the header's own height changes what can be scrolled
    if (top > 60 && !this.mini() && body.scrollHeight - body.clientHeight > 260) this.mini.set(true);
    else if (top < 8 && this.mini()) { this.mini.set(false); this.closePeek(); }
    if (this.peek() && this.peekAt !== null && Math.abs(top - this.peekAt) > 80) this.closePeek();
    this.awayFromLatest.set(body.scrollHeight - top - body.clientHeight > 600);
    // scrolled up to the start: the earlier history comes in above, and the view stays where it was
    const tl = this.timeline();
    if (top < 200 && tl?.hasEarlier() && !this.revealing) {
      // once: the earlier history comes in above, and the thread the user was looking at stays where it was
      this.revealing = true;
      const anchor = Array.from(body.querySelectorAll('.cd-timeline > .cd-thread, .cd-timeline > .cd-day'))
        .find((el) => el.getBoundingClientRect().bottom > body.getBoundingClientRect().top) as HTMLElement | undefined;
      const offset = anchor ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().top : 0;
      tl.showMore();
      this.afterRender(() => this.settle(() => {
        if (anchor?.isConnected) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
      }, () => { this.revealing = false; }));
    }
  }

  /** Opens the shrunk header in place; the activity stays where it is. */
  openPeek(): void {
    this.peekAt = null;
    this.peek.set(true);
    // the taller header shortens the body (and may clamp its scroll): measure from where that leaves it
    this.afterRender(() => { this.peekAt = this.body()?.scrollTop ?? 0; });
  }

  closePeek(): void {
    this.peek.set(false);
    this.peekAt = null;
  }

  scrollTop(): void {
    (this.host.nativeElement as HTMLElement).querySelector('.cd-body')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  stepTo(id: string | null): void {
    if (id) this.step.emit(id);
  }

  /** The card's own keys (specs/023) - none of them is one of the board's card keys. True when one was used. */
  private cardKeys(event: KeyboardEvent): boolean {
    const c = this.card();
    if (!c) return false;
    const digit = /^Digit([1-4])$/.exec(event.code);
    if (event.shiftKey && digit) {
      const tab = (['activity', 'details', 'links', 'retest'] as const)[Number(digit[1]) - 1];
      if (tab !== 'retest' || this.retestShown()) this.showTab(tab);
      return true;
    }
    if (event.key === '[' || event.key === ']') {
      const s = this.siblings();
      this.stepTo(s ? (event.key === '[' ? s.prev : s.next) : null);
      return true;
    }
    if (event.key === '?') {
      this.keysOpen.set(true);
      return true;
    }
    if (event.key === '/' && this.editable()) {
      this.composer()?.focus();
      return true;
    }
    if ((event.key === 'e' || event.key === 'E') && !event.shiftKey && this.editable()) {
      this.editDescription();
      return true;
    }
    return false;
  }

  editDescription(): void {
    this.pickedTab.set('details');
    this.setSection('desc', true);
    this.editingDescription.set(true);
  }

  openFind(): void {
    this.searching.set(true);
    setTimeout(() => ((this.host.nativeElement as HTMLElement).querySelector('.cd-find') as HTMLInputElement | null)?.focus());
  }

  closeFind(): void {
    this.searching.set(false);
    this.query.set('');
  }

  copyNumber(): void {
    const c = this.card();
    if (c) this.copy(`#${c.number}`, 'num');
  }

  copyCycleId(): void {
    this.menuOpen.set(null);
    const c = this.card();
    if (c?.cycleId) this.copy(c.cycleId, 'cycle');
  }

  readonly retestShown = computed(() => {
    const c = this.card();
    return !!c && c.status !== 'INBOX' && c.status !== 'CLOSED';
  });
  readonly retestFailing = computed(() => {
    const v = this.verdict();
    return this.retestShown() && v?.tone === 'fail' ? v : null;
  });
  verdictShort(v: Verdict): string {
    const t = v.text.replace(/\s*·.*$/, '');
    return t.length > 22 ? `${t.slice(0, 22)}…` : t;
  }
  readonly openBlockers = computed(() => (this.card()?.blockedBy ?? []).filter((b) => b.status !== 'DONE' && b.status !== 'CLOSED' && b.status !== 'VERIFIED'));
  readonly linkCount = computed(() => {
    const c = this.card();
    return c ? c.links.length + (c.specItems?.length ?? 0) + (c.blockedBy?.length ?? 0) : 0;
  });
  readonly newCount = computed(() => {
    const since = this.newSince();
    return since ? this.activity().filter((e) => e.kind === 'COMMENT' && isNewEntry(e, since)).length : 0;
  });

  readonly descriptionChanged = computed(() => {
    const since = this.newSince();
    return !!since && this.activity().some((e) => e.kind === 'DESCRIPTION' && e.actor !== 'USER' && after(e.at, since));
  });
  /** Long enough to fold to its first lines with Read all. */
  readonly longDescription = computed(() => {
    const d = this.card()?.description ?? '';
    return d.length > 1500 || d.split('\n').length > 18;
  });
  readonly descSummary = computed(() => {
    const d = (this.card()?.description ?? '').replace(/[#*_`>\[\]]/g, '').replace(/@\[[a-z]+:[^|\]]*\|([^\]]*)\]/g, '$1').replace(/\s+/g, ' ').trim();
    return d ? (d.length > 90 ? `${d.slice(0, 90)}…` : d) : 'none yet';
  });

  /** What waits on the user, and the context-only notes (looks like #N, the reason). */
  readonly needs = computed(() => {
    const c = this.card();
    if (!c) return null;
    const parts: string[] = [];
    if (c.proposal) parts.push('a proposal');
    if (c.openQuestions) parts.push(`${c.openQuestions} question${c.openQuestions === 1 ? '' : 's'}`);
    const blocked = this.openBlockers();
    if (blocked.length) parts.push(`blocked by #${blocked[0].number}${blocked.length > 1 ? ` +${blocked.length - 1}` : ''}`);
    if (this.retestFailing()) parts.push('re-test failing');
    const rows = parts;
    const notes = (c.similarClosed ? 1 : 0) + (c.reason ? 1 : 0);
    const notesSummary = [c.similarClosed ? `looks like #${c.similarClosed.number}` : '', c.reason ? 'reason' : ''].filter(Boolean).join(' · ');
    if (!rows.length && !notes) return null;
    return { rows, notes, notesSummary, summary: rows.length ? rows.join(' · ') : notesSummary };
  });

  /** Inbox › To do › In progress › Fixed › Verified › Done: where the card is, when it reached each step. */
  readonly journey = computed(() => {
    const c = this.card();
    if (!c) return [];
    const reached = new Map<string, string>();
    for (const e of this.activity()) if (e.kind === 'STATUS' && e.newValue) reached.set(e.newValue, e.at);
    if (!reached.has('INBOX')) reached.set('INBOX', c.createdAt);
    const at = c.status === 'CLOSED' ? -1 : JOURNEY.indexOf(c.status);
    const short = (iso?: string) => (iso ? dayLabel(iso, new Date()).replace('Today', 'today').replace('Yesterday', 'yesterday') : '');
    const steps: { status: string; label: string; state: 'done' | 'now' | 'todo'; at: string; title: string; proposed: boolean }[] = JOURNEY.map((s, i) => {
      // ✓ only for a step the card really went through (Fixed → Done skips Verified)
      const state: 'done' | 'now' | 'todo' = i === at ? 'now' : (at < 0 || i < at) && reached.has(s) ? 'done' : 'todo';
      const when = reached.get(s);
      return { status: s, label: STATUS_LABELS[s], state, at: short(when), proposed: state === 'todo' && c.proposal?.status === s,
        title: (when ? `${STATUS_LABELS[s]} on ${new Date(when).toLocaleString()}` : STATUS_LABELS[s]) + (this.editable() && state !== 'now' ? ' - click to move the card here' : '') };
    });
    if (c.status === 'CLOSED') {
      steps.push({ status: 'CLOSED', label: `Closed · ${c.resolution ? RESOLUTION_LABELS[c.resolution] : ''}`, state: 'now', at: short(reached.get('CLOSED') ?? c.updatedAt),
        title: 'Closed - pick a status above to reopen it', proposed: false });
    }
    return steps;
  });

  statusText(c: CardDetail): string {
    return c.status === 'CLOSED' && c.resolution ? `Closed · ${RESOLUTION_LABELS[c.resolution]}` : STATUS_LABELS[c.status];
  }

  /** Quick replies while Claude waits on the user: to Claude's latest comment. */
  readonly quickReplies = computed(() => {
    const c = this.card();
    if (!c || !(c.openQuestions || c.proposal || c.waiting?.who === 'USER')) return null;
    const last = [...this.activity()].reverse().find((e) => e.kind === 'COMMENT' && e.actor === 'CLAUDE');
    // ✅ is a toggle: once the user's is on, a second one would take the go-ahead back
    const given = !!last && reactionsOf(this.activity(), last.id).some((r) => r.emoji === '✅' && r.mine);
    return { goAhead: last && !given ? last : null, replyTo: last ? last.replyTo ?? last.id : null };
  });

  goAhead(): void {
    const c = this.card();
    const target = this.quickReplies()?.goAhead;
    if (!c || !target) return;
    this.api.react(c.id, target.id, '✅').subscribe({ next: () => this.load(c.id), error: (e) => this.error.set(messageOf(e)) });
  }

  quickReply(text: string): void {
    const to = this.quickReplies()?.replyTo;
    if (to != null) this.reply({ text, replyTo: to, clearDecision: false });
  }

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
    // decided before either answer arrives: the activity may come back before the card does
    if (id !== this.loadedId) this.landOnLatest = true;
    this.api.card(id).subscribe({
      next: (c) => {
        this.readAt.set(Date.now());
        if (this.loadedId !== c.id) {
          // a new card in the drawer: what is new since the user last looked, and the view starts fresh
          this.loadedId = c.id;
          this.awayFromLatest.set(false);
          this.newSince.set(this.seen.seenAt(c.id));
          this.pickedTab.set(null);
          this.verdict.set(null);
          this.closeFind();
          this.notesOpen.set(false);
          this.descOpen.set(false);
          this.mini.set(false);
          this.closePeek();
          this.loadCycleName(c.cycleId);
        }
        this.card.set(c);
        this.returns.openCard.set({ project: c.project, number: c.number, title: c.title });
        this.error.set(null);
        this.seen.markSeen(c);
        this.restorePickedText(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
    const stick = !this.landOnLatest && this.nearLatest();
    this.api.activity(id).subscribe({
      next: (page) => {
        this.activity.set(page.entries);
        this.activityTotal.set(page.total);
        if (this.landOnLatest || stick) {
          const how = this.landOnLatest ? 'open' : 'bottom';
          this.landOnLatest = false;
          this.afterRender(() => this.scrollToLatest(how));
        }
      },
      error: () => undefined,
    });
  }

  /** The cycle whose name the drawer is waiting for - the card itself is set only after the name is asked for. */
  private wantedCycle: string | null = null;

  private loadCycleName(id: string | null): void {
    this.wantedCycle = id;
    this.cycleName.set(id ? cycleNames.get(id) ?? null : null);
    if (!id || cycleNames.has(id)) return;
    this.cyclesApi.get(id).subscribe({
      next: (cycle) => {
        cycleNames.set(id, cycle.name);
        // compared with the cycle asked for, not the card: a quick (or cached) answer comes before the card is set
        if (this.wantedCycle === id) this.cycleName.set(cycle.name);
      },
      // specs/027: a card's task key is its board's id - a board made after the update is no cycle, so show its name
      error: () => this.api.board(id).subscribe({
        next: (b) => {
          cycleNames.set(id, b.board.name);
          if (this.wantedCycle === id) this.cycleName.set(b.board.name);
        },
        error: () => undefined,
      }),
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

  copy(text: string, what: 'cmd' | 'issue' | 'num' | 'cycle'): void {
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

  /** specs/021: the few words every mention of the card reads - its short name, else the title cut short. */
  shortNameOf(c: CardDetail): string {
    return c.shortName || shortOf(c.title);
  }

  saveShortName(name: string): void {
    this.editingShort.set(false);
    const c = this.card();
    if (!c || name.trim() === (c.shortName ?? '')) return;
    this.apply(this.api.setCardShortName(c.id, name.trim()).pipe(tap(() => this.mentions.forget())));
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
        if (this.alsoTracker()) this.postToTracker(c.id, c.cycleId, text);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** "Also post to …" (specs/028 FR-080): the user's own comment, sent to each linked work item now. */
  private postToTracker(cardId: string, boardId: string | null, text: string): void {
    for (const i of this.teamItems()) {
      this.teamApi.direct(i.conn, i.item, { comment: text, card: cardId, board: boardId }).subscribe({
        error: (e) => this.error.set(e?.error?.message || `Could not post to ${i.item}`),
      });
    }
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
