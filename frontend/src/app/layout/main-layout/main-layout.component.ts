import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { PickBarComponent } from '../../components/pick-bar/pick-bar.component';
import { ResendDialogComponent } from '../../components/resend-dialog/resend-dialog.component';
import { BulkResendDialogComponent } from '../../components/bulk-resend-dialog/bulk-resend-dialog.component';
import { RuleDialogComponent } from '../../components/rule-dialog/rule-dialog.component';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { GlobalVariablesComponent } from '../../components/global-variables/global-variables.component';
import { CycleWidgetLaunchComponent } from '../../components/cycle-widget/cycle-widget-launch.component';
import { ReliveFingerprintScreenComponent } from '../../components/relive-fingerprint-screen/relive-fingerprint-screen.component';
import { ScenarioToolbarComponent } from '../../components/scenario-toolbar/scenario-toolbar.component';

/** First tab-nav shell in the app - "Live Calls" (the original dashboard) and "Session Cycles" render as children below this same nav bar. The /view route deliberately stays outside this layout (opened via window.open, wants the full page to itself). The theme picker lives here rather than in `HeaderComponent` since it's app-wide, not per-page. */
import { BoardNotifyService } from '../../core/services/board-notify.service';
import { SpecViewerComponent } from '../../components/board/spec-viewer/spec-viewer.component';
import { MentionCallPopupComponent } from '../../components/board/mention-call-popup/mention-call-popup.component';
import { ChatDockComponent } from '../../components/chat/chat-dock/chat-dock.component';
import { ChatStateService } from '../../core/state/chat-state.service';
import { LinksTrayComponent } from '../../components/links/links-tray/links-tray.component';
import { StreamDialogComponent } from '../../components/links/stream-dialog/stream-dialog.component';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, PickBarComponent, ResendDialogComponent, BulkResendDialogComponent, ScenarioToolbarComponent, RuleDialogComponent, GlobalVariablesComponent, CycleWidgetLaunchComponent, ReliveFingerprintScreenComponent, SpecViewerComponent, MentionCallPopupComponent, ChatDockComponent, LinksTrayComponent, StreamDialogComponent],
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
  /** Claude's questions and proposals as desktop notifications, once the user turned them on (specs/015). */
  private readonly boardNotify = inject(BoardNotifyService);
  /** The board chats' unread count on the Board tab (specs/022). */
  readonly chat = inject(ChatStateService);
}
