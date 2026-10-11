import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { ActivityEntry, MentionRef } from '../../../core/models/board.models';
import { CardPickTarget } from '../../../core/services/board-mentions.service';
import { ClaudeParts, changeText, claudeParts } from '../../../shared/utils/board-activity';
import { HistoryItem, historyThreads, openQuestions } from '../../../shared/utils/board-threads';
import { parseMentions } from '../../../shared/utils/mention-syntax';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/** A reply written in the timeline: to which comment, and whether answering clears Needs decision. */
export interface TimelineReply {
  readonly text: string;
  readonly replyTo: number;
  readonly clearDecision: boolean;
}

/**
 * A card's history, oldest first (FR-027, FR-028): comments in full, every change in one line, and the replies to a
 * comment gathered under it. Every comment has ↩ Reply; Claude's open question has Answer, with "clear Needs decision"
 * ticked when it is the last open one.
 */
@Component({
  selector: 'app-activity-timeline',
  standalone: true,
  imports: [MarkdownViewComponent, MentionChipComponent, MentionEditorComponent, NgTemplateOutlet],
  template: `
    <div class="board-timeline">
      @for (item of items(); track item.entry.id) {
        @if (item.entry.kind === 'COMMENT') {
          <div class="board-ev" [class.claude]="item.entry.actor === 'CLAUDE'" [class.me]="item.entry.actor === 'USER'">
            <div class="board-ev-who"><b>{{ who(item.entry) }}</b> · {{ when(item.entry.at) }}
              @if (item.question) {
                <span class="board-ev-badge" [class.answered]="item.answered">{{ item.answered ? '✓ answered' : 'waiting for you' }}</span>
              }
            </div>
            <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: item.entry }" />
            @if (editable()) {
              <div class="board-ev-acts">
                <button type="button" class="board-link" (click)="startReply(item)">
                  {{ item.question && !item.answered ? '↩ Answer' : '↩ Reply' }}</button>
                @if (item.replies.length) { <span class="board-dim">{{ item.replies.length }} {{ item.replies.length === 1 ? 'reply' : 'replies' }}</span> }
              </div>
            }
            @for (r of item.replies; track r.id) {
              <div class="board-ev-reply" [class.claude]="r.actor === 'CLAUDE'">
                <div class="board-ev-who"><b>{{ who(r) }}</b> · {{ when(r.at) }}
                  @if (item.question && r.actor === 'USER') { <span class="board-dim">answer</span> }
                </div>
                <ng-container [ngTemplateOutlet]="body" [ngTemplateOutletContext]="{ $implicit: r }" />
                @if (editable()) {
                  <div class="board-ev-acts"><button type="button" class="board-link" (click)="startReply(item)">↩ Reply</button></div>
                }
              </div>
            }
            @if (replyingTo() === item.entry.id) {
              <div class="board-ev-replybox">
                <div class="board-ev-replyto">
                  <span>{{ item.question && !item.answered ? 'Answering' : 'Replying to' }} {{ who(item.entry) }}: “{{ quote(item.entry) }}”</span>
                  <button type="button" class="board-link" title="Cancel" (click)="replyingTo.set(null)">✕</button>
                </div>
                <app-mention-editor [project]="project()" [cycleId]="cycleId()" [card]="card()" [rows]="2" [cancellable]="true"
                                    [submitLabel]="item.question && !item.answered ? 'Answer' : 'Reply'"
                                    placeholder="Write your reply… type @ to mention" (submitted)="send(item, $event)"
                                    (cancelled)="replyingTo.set(null)" />
                @if (item.question && !item.answered) {
                  <label class="board-ev-clear"><input type="checkbox" [checked]="clearDecision()" (change)="clearDecision.set($any($event.target).checked)" />
                    Clear "Needs decision"{{ otherOpen(item) ? ' (' + otherOpen(item) + ' other question' + (otherOpen(item) === 1 ? '' : 's') + ' still open - stays on)' : '' }}</label>
                }
              </div>
            }
          </div>
        } @else {
          <div class="board-ev sys">
            @for (seg of change(item.entry); track $index) {
              @if (seg.mention; as m) { <app-mention-chip [mention]="m" [showPreview]="false" /> } @else { {{ seg.text }} }
            } · {{ when(item.entry.at) }}
          </div>
        }
      } @empty {
        <div class="board-dim">No history yet.</div>
      }
    </div>
    <ng-template #body let-e>
      <div class="board-ev-body">
        @if (parts(e.text); as ps) {
          @for (p of ps; track $index) {
            <div class="board-ev-part"><span class="board-ev-label">{{ p.label }}</span><app-markdown-view [text]="p.text" /></div>
          }
        } @else {
          <app-markdown-view [text]="e.text" />
        }
      </div>
    </ng-template>`,
})
export class ActivityTimelineComponent {
  readonly entries = input.required<readonly ActivityEntry[]>();
  readonly editable = input(false);
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly card = input<CardPickTarget | null>(null);
  readonly replied = output<TimelineReply>();

  readonly items = computed(() => historyThreads(this.entries()));
  readonly replyingTo = signal<number | null>(null);
  readonly clearDecision = signal(true);

  startReply(item: HistoryItem): void {
    this.clearDecision.set(true);
    this.replyingTo.set(item.entry.id);
  }

  send(item: HistoryItem, text: string): void {
    const answering = item.question && !item.answered;
    this.replied.emit({ text, replyTo: item.entry.id, clearDecision: answering && this.clearDecision() });
    this.replyingTo.set(null);
  }

  /** Claude's other unanswered questions on the card - while any stays open, the flag stays on. */
  otherOpen(item: HistoryItem): number {
    return Math.max(0, openQuestions(this.entries()) - (item.question && !item.answered ? 1 : 0));
  }

  who(e: ActivityEntry): string {
    return e.actor === 'CLAUDE' ? '✦ Claude' : 'You';
  }

  quote(e: ActivityEntry): string {
    const plain = (e.text ?? '').replace(/^\*\*(Did|Found|Next|Impact|Reply|Question)\*\*\s*/, '').replace(/@\[[a-z]+:[^|\]]*\|([^\]]*)\]/g, '$1')
      .replace(/\s+/g, ' ').trim();
    return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
  }

  parts(text: string | null): ClaudeParts[] | null {
    return claudeParts(text);
  }

  /** The one-line change, its mentions (a link added or removed) as pills rather than their `@[...]` text. */
  change(e: ActivityEntry): { text?: string; mention?: MentionRef }[] {
    return parseMentions(changeText(e)).map((s) => ('mention' in s ? { mention: s.mention } : { text: s.text }));
  }

  when(iso: string): string {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}
