import { Component, computed, inject, input } from '@angular/core';
import { TeamsStateService } from '../../../core/state/teams-state.service';

/** A card's teams as coloured chips - on the board card, in the list and anywhere else a card is shown. */
@Component({
  selector: 'app-team-chips',
  standalone: true,
  template: `
    @for (t of shown(); track t.id) {
      <span class="board-team" [style.--team]="t.color" [title]="t.name + (t.owns ? ' - ' + t.owns : '')">
        @if (t.icon) { <span aria-hidden="true">{{ t.icon }}</span> }{{ t.name }}
      </span>
    }`,
})
export class TeamChipsComponent {
  private readonly teamsState = inject(TeamsStateService);
  readonly teams = input<readonly string[] | undefined>([]);
  readonly shown = computed(() => this.teamsState.of(this.teams()));

  constructor() {
    this.teamsState.load();
  }
}
