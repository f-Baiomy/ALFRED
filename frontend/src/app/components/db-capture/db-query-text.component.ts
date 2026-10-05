import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { renderQueryText } from '../../shared/utils/sql-render';

/** The query as the code wrote it (HQL/JPQL or native SQL): keywords and named parameters marked. */
@Component({
  standalone: true,
  selector: 'app-db-query-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (t of tokens(); track $index) {@switch (t.kind) {
    @case ('kw') {<span class="kw">{{ t.text }}</span>}
    @case ('np') {<span class="np">{{ t.text }}</span>}
    @default {{{ t.text }}}
  }}`,
})
export class DbQueryTextComponent {
  readonly text = input.required<string>();
  readonly oneLine = input(false);

  readonly tokens = computed(() => renderQueryText(this.text(), this.oneLine()));
}
