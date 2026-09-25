import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { HeaderComponent } from '../../components/header/header.component';
import { StatsBarComponent } from '../../components/stats-bar/stats-bar.component';
import { CallListComponent } from '../../components/call-list/call-list.component';
import { ExportDialogComponent } from '../../components/export-dialog/export-dialog.component';
import { CopyToCyclesDialogComponent } from '../../components/copy-to-cycles-dialog/copy-to-cycles-dialog.component';
import { BulkActionsBarComponent } from '../../components/bulk-actions-bar/bulk-actions-bar.component';
import { CallsStateService } from '../../core/state/calls-state.service';
import { CallFocusService } from '../../core/services/call-focus.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [HeaderComponent, StatsBarComponent, CallListComponent, ExportDialogComponent, CopyToCyclesDialogComponent, BulkActionsBarComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  readonly state = inject(CallsStateService);

  constructor() {
    // `/?requestId=<id>` shows that one call - "Made from…" on a rule, a resend's "open original".
    const focus = inject(CallFocusService);
    inject(ActivatedRoute)
      .queryParamMap.pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((params) => focus.applyTo(this.state, null, params.get('requestId')));
  }
}
