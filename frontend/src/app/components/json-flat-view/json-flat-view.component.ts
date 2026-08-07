import { Component, input, output, signal } from '@angular/core';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { HighlightToken } from '../../shared/utils/json-tokenizer';
import { Comment } from '../../core/models/comment.model';

export type FlatViewVariant = 'json' | 'plain';

export interface LineTokens {
  readonly index: number;
  readonly tokens: readonly HighlightToken[];
}

export interface NewCommentEvent {
  readonly lineIndex: number;
  readonly lineText: string;
  readonly comment: string;
}

/**
 * Renders one row per line (rather than one flat blob of tokens) so each
 * line can carry its own gutter: a hover "+" to flag an issue on that line,
 * GitHub-style, and any existing comments shown as cards right below it.
 */
@Component({
  selector: 'app-json-flat-view',
  standalone: true,
  imports: [JsonTokensComponent],
  templateUrl: './json-flat-view.component.html',
})
export class JsonFlatViewComponent {
  readonly lines = input.required<readonly LineTokens[]>();
  readonly variant = input<FlatViewVariant>('json');
  readonly activeMatchIndex = input<number>(-1);
  readonly scrollId = input<string | undefined>(undefined);
  readonly commentsByLine = input<ReadonlyMap<number, Comment[]>>(new Map());

  readonly addComment = output<NewCommentEvent>();
  readonly deleteComment = output<string>();

  readonly openCommentLineIndex = signal<number | null>(null);
  readonly draftText = signal('');

  toggleAddComment(lineIndex: number): void {
    this.openCommentLineIndex.set(this.openCommentLineIndex() === lineIndex ? null : lineIndex);
    this.draftText.set('');
  }

  cancelAddComment(): void {
    this.openCommentLineIndex.set(null);
    this.draftText.set('');
  }

  submitComment(line: LineTokens): void {
    const comment = this.draftText().trim();
    if (!comment) return;
    this.addComment.emit({
      lineIndex: line.index,
      lineText: line.tokens.map((t) => t.text).join(''),
      comment,
    });
    this.cancelAddComment();
  }
}
