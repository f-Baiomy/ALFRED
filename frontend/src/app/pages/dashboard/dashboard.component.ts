import { Component, inject } from '@angular/core';
import { HeaderComponent } from '../../components/header/header.component';
import { StatsBarComponent } from '../../components/stats-bar/stats-bar.component';
import { CallListComponent } from '../../components/call-list/call-list.component';
import { ExportDialogComponent } from '../../components/export-dialog/export-dialog.component';
import { CallsStateService } from '../../core/state/calls-state.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [HeaderComponent, StatsBarComponent, CallListComponent, ExportDialogComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  readonly state = inject(CallsStateService);
}
