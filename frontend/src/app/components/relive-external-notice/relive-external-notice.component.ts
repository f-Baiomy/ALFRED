import { Component, input, output } from '@angular/core';
import { ExternalNotice } from '../../pages/relive-cycle/relive-cycle-editor.state';

/**
 * "X can now contact the real system" (FR-015a; mock.html `notifyExternal()`), stacked bottom-left
 * so it never covers the drawer on the right. One per notice in `ReliveCycleEditorState.notices`.
 */
@Component({
  selector: 'app-relive-external-notice',
  standalone: true,
  templateUrl: './relive-external-notice.component.html',
})
export class ReliveExternalNoticeComponent {
  readonly notices = input.required<readonly ExternalNotice[]>();
  readonly undo = output<string>();
  readonly dismiss = output<string>();
}
