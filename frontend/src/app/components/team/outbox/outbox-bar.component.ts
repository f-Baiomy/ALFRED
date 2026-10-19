import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { OutboxTrayComponent } from './outbox-tray.component';

/**
 * The ⇪ pill and its tray for a board with no facts line - the project's default board (specs/034). Nothing shows while
 * nothing waits. The tray opens by itself once per board; then it is the user's to close.
 */
@Component({
  selector: 'app-team-outbox-bar',
  standalone: true,
  imports: [OutboxTrayComponent],
  template: `
    @if (outbox.count() || outbox.partial().length) {
      <div class="tob-bar">
        <button type="button" class="tob-pill" [attr.aria-expanded]="tray()" (click)="tray.set(!tray())">
          ⇪ {{ outbox.count() || outbox.partial().length }} {{ outbox.count() ? 'to send to Azure' : 'not all sent' }} {{ tray() ? '▾' : '▸' }}</button>
      </div>
      @if (tray()) { <app-team-outbox-tray [project]="project()" [editable]="editable()" (closed)="tray.set(false)" /> }
    }`,
})
export class OutboxBarComponent {
  readonly outbox = inject(BundleOutboxService);
  readonly boardId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);
  readonly tray = signal(false);
  private shownFor: string | null = null;

  constructor() {
    effect(() => this.outbox.watch(this.boardId()), { allowSignalWrites: true });
    effect(() => {
      const id = this.boardId();
      if (this.outbox.count() && this.shownFor !== id) {
        this.shownFor = id;
        untracked(() => this.tray.set(true));
      }
    }, { allowSignalWrites: true });
  }
}
