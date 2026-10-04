import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RedactionsStore } from '../../core/state/redactions-store.service';

/**
 * "Hide in exports" for one database column: adds (or removes) a global `db-column` redaction, so the column's
 * values - and the parameters bound to it - are masked in every .md/.json/.html export. The window itself keeps
 * showing them: redaction protects the shared file, never what you debug with.
 */
@Component({
  standalone: true,
  selector: 'app-db-hide-column',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rule(); as r) {
      <button type="button" class="db-hide on" title="Hidden in exports - click to include it again" (click)="toggle($event)">⊘ hidden in exports</button>
    } @else {
      <button type="button" class="db-hide" [title]="'Hide ' + column() + ' in every export (the window keeps showing it)'" (click)="toggle($event)">⊘</button>
    }
  `,
})
export class DbHideColumnComponent {
  private readonly redactions = inject(RedactionsStore);
  readonly column = input.required<string>();

  readonly rule = computed(() => {
    const name = this.column().toLowerCase();
    return this.redactions.all().find((r) => r.kind === 'db-column' && r.scope === 'all' && r.name.toLowerCase() === name);
  });

  toggle(event: Event): void {
    event.stopPropagation();
    const rule = this.rule();
    if (rule) this.redactions.remove(rule.id);
    else this.redactions.add({ scope: 'all', callId: null, kind: 'db-column', name: this.column() });
  }
}
