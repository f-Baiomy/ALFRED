import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { createEditorSessionId, editorChannelName, editorStorageKey } from '../../shared/utils/editor-bridge';

export interface EditorSession {
  /** Emits the editor's current text on every change - only while it's valid JSON is the caller's contract, not this service's concern. */
  readonly updates$: Observable<string>;
  close(): void;
}

/**
 * Opens a call's JSON body/headers in a genuinely separate browser tab for
 * free-form editing (a real CodeMirror editor, not squeezed into the panel),
 * and streams every live edit back here via BroadcastChannel so the
 * original panel can update as-you-type. sessionStorage carries the
 * starting text into the new tab - the browser clones it into any
 * same-origin tab opened via window.open, so no server round-trip is
 * needed just to seed the editor.
 */
@Injectable({ providedIn: 'root' })
export class JsonEditorBridgeService {
  openEditor(label: string, initialText: string): EditorSession {
    const sessionId = createEditorSessionId();
    sessionStorage.setItem(editorStorageKey(sessionId), initialText);

    const url = `/editor?session=${encodeURIComponent(sessionId)}&label=${encodeURIComponent(label)}`;
    window.open(url, '_blank');

    const channel = new BroadcastChannel(editorChannelName(sessionId));

    const updates$ = new Observable<string>((subscriber) => {
      const handler = (event: MessageEvent<{ type: string; text: string }>) => {
        if (event.data?.type === 'update' && typeof event.data.text === 'string') {
          subscriber.next(event.data.text);
        }
      };
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    });

    return {
      updates$,
      close: () => {
        channel.close();
        sessionStorage.removeItem(editorStorageKey(sessionId));
      },
    };
  }
}
