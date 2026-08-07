import { Component, input } from '@angular/core';
import { CallStats } from '../../core/state/calls-state.service';

@Component({
  selector: 'app-stats-bar',
  standalone: true,
  templateUrl: './stats-bar.component.html',
})
export class StatsBarComponent {
  readonly stats = input.required<CallStats>();
}
