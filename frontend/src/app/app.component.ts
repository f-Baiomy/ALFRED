import { Component, inject } from '@angular/core';
import { HeaderComponent } from './components/header/header.component';
import { StatsBarComponent } from './components/stats-bar/stats-bar.component';
import { CallListComponent } from './components/call-list/call-list.component';
import { CallsStateService } from './core/state/calls-state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HeaderComponent, StatsBarComponent, CallListComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  readonly state = inject(CallsStateService);
}
