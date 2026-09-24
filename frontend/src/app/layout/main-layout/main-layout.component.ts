import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { PickBarComponent } from '../../components/pick-bar/pick-bar.component';
import { ResendDialogComponent } from '../../components/resend-dialog/resend-dialog.component';
import { ThemePickerComponent } from '../../components/theme-picker/theme-picker.component';
import { InterceptionStateService } from '../../core/state/interception-state.service';

/** First tab-nav shell in the app - "Live Calls" (the original dashboard) and "Session Cycles" render as children below this same nav bar. The /view route deliberately stays outside this layout (opened via window.open, wants the full page to itself). The theme picker lives here rather than in `HeaderComponent` since it's app-wide, not per-page. */
@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, ThemePickerComponent, PickBarComponent, ResendDialogComponent],
  templateUrl: './main-layout.component.html',
})
export class MainLayoutComponent {
  /**
   * Injected by the SHELL rather than only by the Interception page, so the paused badge is live
   * from anywhere in the app. If a rule is holding somebody's connection open, that must be
   * visible while you are looking at Live Calls, not only once you happen to open the tab that
   * can release it.
   */
  readonly interception = inject(InterceptionStateService);
}
