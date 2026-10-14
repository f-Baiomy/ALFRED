import { Component, computed, input } from '@angular/core';
import { parseStats } from '../../../shared/utils/board-visuals';
import { textDir } from '../../../shared/utils/text-direction';

/** A ```stats block (specs/017 R2): one card per line - label, value, colour, note. Each card reads in its own direction. */
@Component({
  selector: 'app-stats-block',
  standalone: true,
  template: `
    @if (parsed().error; as err) {
      <div class="board-vis"><div class="board-vis-err">{{ err }}</div><pre class="board-vis-src">{{ source() }}</pre></div>
    } @else {
      <div class="board-stats">
        @for (c of parsed().model; track $index) {
          <div class="board-stat" [attr.dir]="dirOf(c.label + ' ' + c.note)">
            <div class="board-stat-k">{{ c.label }}</div>
            <div class="board-stat-v" [class]="'board-stat-v' + (c.color ? ' c-' + c.color : '')" dir="auto">{{ c.value }}</div>
            @if (c.note) { <div class="board-stat-d" [class]="'board-stat-d' + (c.color ? ' c-' + c.color : '')">{{ c.note }}</div> }
          </div>
        }
      </div>
    }`,
})
export class StatsBlockComponent {
  readonly source = input.required<string>();
  readonly parsed = computed(() => parseStats(this.source()));

  dirOf(text: string): string {
    return textDir(text) ?? 'auto';
  }
}
