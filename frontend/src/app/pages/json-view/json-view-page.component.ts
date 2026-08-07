import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { JsonPanelComponent } from '../../components/json-panel/json-panel.component';
import { CommentBlock } from '../../core/models/comment.model';
import { panelViewStorageKey } from '../../shared/utils/panel-view-bridge';

/**
 * The "open in new tab" destination: renders the exact same
 * JsonPanelComponent the dashboard uses, just with more room. Any feature
 * added to JsonPanelComponent (search, tree/flat, comments, whatever comes
 * next) shows up here automatically, because this page doesn't reimplement
 * any of it - it only seeds the panel's inputs and gets out of the way.
 */
@Component({
  selector: 'app-json-view-page',
  standalone: true,
  imports: [JsonPanelComponent],
  templateUrl: './json-view-page.component.html',
})
export class JsonViewPageComponent {
  private readonly route = inject(ActivatedRoute);

  readonly callId = signal('');
  readonly block = signal<CommentBlock>('request-body');
  readonly label = signal('JSON');
  readonly rawValue = signal<unknown>(undefined);
  readonly expired = signal(false);

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    const callId = params.get('callId');
    const block = params.get('block') as CommentBlock | null;

    if (!callId || !block) {
      this.expired.set(true);
      return;
    }

    const stored = sessionStorage.getItem(panelViewStorageKey(callId, block));
    if (stored === null) {
      this.expired.set(true);
      return;
    }

    this.callId.set(callId);
    this.block.set(block);
    this.label.set(params.get('label') || 'JSON');
    this.rawValue.set(JSON.parse(stored));
  }

  closeTab(): void {
    window.close();
  }
}
