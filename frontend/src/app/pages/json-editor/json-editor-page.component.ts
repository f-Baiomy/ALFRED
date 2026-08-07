import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { EditorState } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { json } from '@codemirror/lang-json';
import { editorChannelName, editorStorageKey } from '../../shared/utils/editor-bridge';
import { tryParseJson } from '../../shared/utils/json-tokenizer';

const darkTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: '#070a24', color: '#e5e9f5' },
    '.cm-content': { fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace", caretColor: '#c4b5fd' },
    '.cm-gutters': { backgroundColor: '#0a0e2a', color: '#5c6690', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(139, 92, 246, 0.08)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(139, 92, 246, 0.12)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(139, 92, 246, 0.35) !important' },
    '.cm-cursor': { borderLeftColor: '#c4b5fd' },
    '.cm-searchMatch': { backgroundColor: 'rgba(251, 191, 36, 0.35)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgba(139, 92, 246, 0.5)' },
  },
  { dark: true }
);

/**
 * The "edit in a new tab" destination: a real CodeMirror JSON editor,
 * seeded from sessionStorage (cloned into this tab by the browser when the
 * opener called window.open, same-origin) and broadcasting every change
 * back to that opener over a BroadcastChannel named after the session id.
 * This page has no idea who opened it or whether they're still listening -
 * it just seeds itself and broadcasts, which is what keeps it decoupled.
 */
@Component({
  selector: 'app-json-editor-page',
  standalone: true,
  templateUrl: './json-editor-page.component.html',
})
export class JsonEditorPageComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);

  @ViewChild('editorHost') private editorHost?: ElementRef<HTMLElement>;

  readonly label = signal('JSON');
  readonly sessionExpired = signal(false);
  readonly isValidJson = signal(true);

  private view?: EditorView;
  private channel?: BroadcastChannel;

  ngAfterViewInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const sessionId = params.get('session');
    this.label.set(params.get('label') || 'JSON');

    const initialText = sessionId ? sessionStorage.getItem(editorStorageKey(sessionId)) : null;
    if (!sessionId || initialText === null) {
      this.sessionExpired.set(true);
      return;
    }

    this.channel = new BroadcastChannel(editorChannelName(sessionId));
    const channel = this.channel;

    const broadcastOnChange = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const text = update.state.doc.toString();
      this.isValidJson.set(tryParseJson(text).ok);
      channel.postMessage({ type: 'update', text });
    });

    this.view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        extensions: [basicSetup, json(), darkTheme, broadcastOnChange],
      }),
      parent: this.editorHost!.nativeElement,
    });
  }

  ngOnDestroy(): void {
    this.view?.destroy();
    this.channel?.close();
  }

  closeTab(): void {
    window.close();
  }
}
