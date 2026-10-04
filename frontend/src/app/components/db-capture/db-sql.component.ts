import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TypedValue } from '../../core/models/db-capture.model';
import { renderSql } from '../../shared/utils/sql-render';
import { DbWindowState } from './db-window-state';

/** Captured SQL with keywords, values and placeholders coloured; a value click traces it through the call. */
@Component({
  standalone: true,
  selector: 'app-db-sql',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (t of tokens(); track $index) {@switch (t.kind) {
    @case ('kw') {<span class="kw">{{ t.text }}</span>}
    @case ('val') {<span class="val" [class.hit]="t.value === state?.trace()" (click)="trace($event, t.value)" [attr.title]="'Click to trace ' + t.value">{{ t.text }}</span>}
    @case ('null') {<span class="val">NULL</span>}
    @case ('ph') {<span class="ph">?</span>}
    @case ('out') {<span class="ph">OUT</span>}
    @case ('blob') {<span class="blob" title="Large value - stored in full">{{ t.text }}</span>}
    @default {{{ t.text }}}
  }}`,
})
export class DbSqlComponent {
  protected readonly state = inject(DbWindowState, { optional: true });
  readonly sql = input.required<string>();
  readonly params = input<readonly TypedValue[] | null | undefined>(null);
  readonly filled = input(true);
  readonly pretty = input(false);

  readonly tokens = computed(() => renderSql(this.sql(), this.params(), { filled: this.filled(), pretty: this.pretty() }));

  trace(event: Event, value: string | null | undefined): void {
    if (!this.state) return;
    event.stopPropagation();
    this.state.toggleTrace(value);
  }
}
