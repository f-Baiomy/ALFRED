import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { PROJECT_SCOPE } from '../../core/models/chat.models';
import { ChatStateService } from '../../core/state/chat-state.service';
import { ChatPanelComponent } from '../../components/chat/chat-panel/chat-panel.component';

/**
 * A board chat in its own window (specs/022 FR-017 "separate window"): /chat?project=&scope=, the panel alone at full
 * size. It reads and writes the same chat as the docked panel - both refetch on the same signal.
 */
@Component({
  selector: 'app-chat-window',
  standalone: true,
  imports: [ChatPanelComponent],
  template: `<div class="chat-window"><app-chat-panel [inWindow]="true" /></div>`,
})
export class ChatWindowComponent {
  constructor() {
    const state = inject(ChatStateService);
    const q = inject(ActivatedRoute).snapshot.queryParamMap;
    const scope = q.get('scope') || PROJECT_SCOPE;
    state.show(q.get('project') ?? '', scope === PROJECT_SCOPE ? null : scope);
    state.openChat(scope);
    document.title = 'Alfred chat';
  }
}
