import { Component, computed, input } from '@angular/core';

/** Open / fixed or verifying / done or closed, as a bar and counts (FR-012). */
@Component({
  selector: 'app-board-progress',
  standalone: true,
  template: `
    <div class="board-progress">
      <span>{{ label() }}</span>
      <div class="board-pbar">
        <i class="done" [style.width.%]="pct().done"></i><i class="fixed" [style.width.%]="pct().fixed"></i><i class="open" [style.width.%]="pct().open"></i>
      </div>
      <span><b class="open">{{ open() }}</b> open · <b class="fixed">{{ fixed() }}</b> fixed / verifying · <b class="done">{{ done() }}</b> done or closed</span>
    </div>`,
})
export class BoardProgressComponent {
  readonly label = input('');
  readonly open = input(0);
  readonly fixed = input(0);
  readonly done = input(0);

  readonly pct = computed(() => {
    const total = this.open() + this.fixed() + this.done() || 1;
    return { open: (this.open() / total) * 100, fixed: (this.fixed() / total) * 100, done: (this.done() / total) * 100 };
  });
}
