import { Component, input } from '@angular/core';
import { ActivityEntry, MentionRef } from '../../../core/models/board.models';
import { ClaudeParts, changeText, claudeParts } from '../../../shared/utils/board-activity';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { parseMentions } from '../../../shared/utils/mention-syntax';

/** A card's history, oldest first (FR-027, FR-028): comments in full, every change in one line. */
@Component({
  selector: 'app-activity-timeline',
  standalone: true,
  imports: [MarkdownViewComponent, MentionChipComponent],
  template: `
    <div class="board-timeline">
      @for (e of entries(); track e.id) {
        @if (e.kind === 'COMMENT') {
          <div class="board-ev" [class.claude]="e.actor === 'CLAUDE'" [class.me]="e.actor === 'USER'">
            <div class="board-ev-who"><b>{{ e.actor === 'CLAUDE' ? '✦ Claude' : 'You' }}</b> · {{ when(e.at) }}</div>
            <div class="board-ev-body">
              @if (parts(e.text); as ps) {
                @for (p of ps; track $index) {
                  <div class="board-ev-part"><span class="board-ev-label">{{ p.label }}</span><app-markdown-view [text]="p.text" /></div>
                }
              } @else {
                <app-markdown-view [text]="e.text" />
              }
            </div>
          </div>
        } @else {
          <div class="board-ev sys">
            @for (seg of change(e); track $index) {
              @if (seg.mention; as m) { <app-mention-chip [mention]="m" [showPreview]="false" /> } @else { {{ seg.text }} }
            } · {{ when(e.at) }}
          </div>
        }
      } @empty {
        <div class="board-dim">No history yet.</div>
      }
    </div>`,
})
export class ActivityTimelineComponent {
  readonly entries = input.required<readonly ActivityEntry[]>();

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
