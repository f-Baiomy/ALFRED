import { Component, inject } from '@angular/core';
import { TeamItemPeekService } from '../../../core/team/item-peek.service';
import { TeamItemDrawerComponent } from '../item-drawer/item-drawer.component';

/** The work item drawer over any page (a mention chip's click), loaded only the first time one opens. */
@Component({
  selector: 'app-team-item-peek-host',
  standalone: true,
  imports: [TeamItemDrawerComponent],
  template: `
    @if (peek.opened(); as o) {
      @defer {
        <app-team-item-drawer [conn]="o.conn" [itemId]="o.item" (closed)="peek.close()" (openOther)="peek.open(o.conn, $event)" />
      }
    }`,
})
export class TeamItemPeekHostComponent {
  readonly peek = inject(TeamItemPeekService);
}
