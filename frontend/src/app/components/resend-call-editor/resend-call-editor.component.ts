import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { EditTabService } from '../../core/services/edit-tab.service';
import { HeaderRow, parseHeaderRows, serializeHeaderRows } from '../../shared/utils/header-rows';
import { ResendDraft, isInbound } from '../../shared/utils/resend-draft';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { HeaderEditorComponent } from '../header-editor/header-editor.component';

type TabPart = 'body' | 'headers';

/**
 * Everything about one call that a resend can change: method, URL, headers, body, and whether to
 * swap in the current session. The headers and body use the same editors - and so the same
 * formatter, colours, find and find-and-replace - as the paused-call inspector and the call card,
 * so a SOAP envelope looks and edits the same here as everywhere else.
 *
 * Either part can be opened in a big tab (the /edit page); every keystroke there streams back over
 * EditTabService and lands in this draft live, and "Editing in another tab" says so meanwhile.
 *
 * Stateless about the draft itself: it only ever emits a whole new draft, so the single Resend
 * dialog and the multi-call editor keep their own copies and decide what "changed" means.
 */
@Component({
  selector: 'app-resend-call-editor',
  standalone: true,
  imports: [BodyEditorComponent, HeaderEditorComponent],
  templateUrl: './resend-call-editor.component.html',
})
export class ResendCallEditorComponent {
  private readonly editTab = inject(EditTabService);

  readonly draft = input.required<ResendDraft>();
  readonly draftChange = output<ResendDraft>();

  readonly inbound = computed(() => isInbound(this.draft()));
  readonly inTab = signal<ReadonlySet<TabPart>>(new Set());

  private readonly stopListening = new Map<TabPart, () => void>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopListening.forEach((stop) => stop()));
  }

  patch(patch: Partial<ResendDraft>): void {
    this.draftChange.emit({ ...this.draft(), ...patch });
  }

  onMethod(event: Event): void {
    this.patch({ method: (event.target as HTMLInputElement).value });
  }

  onUrl(event: Event): void {
    this.patch({ url: (event.target as HTMLInputElement).value });
  }

  onHeaders(headers: HeaderRow[]): void {
    this.patch({ headers });
  }

  onBody(body: string): void {
    this.patch({ body });
  }

  onSession(event: Event): void {
    this.patch({ useCurrentSession: (event.target as HTMLInputElement).checked });
  }

  /** Opens one part full-page in a new tab and takes every edit made there straight into this draft. */
  openInTab(part: TabPart): void {
    const draft = this.draft();
    const key = `${draft.key}-${part}`;
    this.stopListening.get(part)?.();
    const stop = this.editTab.listen(key, {
      value: (value) => {
        if (part === 'body') {
          this.patch({ body: value });
        } else {
          const rows = parseHeaderRows(value);
          if (rows) this.patch({ headers: rows });
        }
      },
      closed: () => this.markTab(part, false),
    });
    this.stopListening.set(part, stop);
    this.markTab(part, true);
    this.editTab.open(key, {
      kind: part,
      title: `${part === 'body' ? 'Body' : 'Headers'} · ${draft.method} ${draft.url}`,
      value: part === 'body' ? draft.body : serializeHeaderRows(draft.headers),
    });
  }

  private markTab(part: TabPart, on: boolean): void {
    const next = new Set(this.inTab());
    if (on) next.add(part);
    else next.delete(part);
    this.inTab.set(next);
  }
}
