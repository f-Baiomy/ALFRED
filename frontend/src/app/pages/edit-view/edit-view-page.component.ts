import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { BodyEditorComponent } from '../../components/body-editor/body-editor.component';
import { HeaderEditorComponent } from '../../components/header-editor/header-editor.component';
import { EditTabSeed, EditTabService } from '../../core/services/edit-tab.service';
import { HeaderRow, parseHeaderRows, serializeHeaderRows } from '../../shared/utils/header-rows';

/**
 * The "open in a big tab" destination for the body and header editors (see EditTabService).
 *
 * Renders the very same BodyEditorComponent / HeaderEditorComponent the opener has, just with the
 * whole window - it reimplements nothing, so find & replace, colouring and validation behave
 * identically in both. Every change is posted back on the key's channel as the whole current value;
 * the opener applies it as if it had been typed in place. Done posts "closed" and shuts the tab.
 *
 * Headers open on the JSON view: the reason to want a big tab for forty headers is to edit them as
 * one text, not as forty tiny input pairs.
 */
@Component({
  selector: 'app-edit-view-page',
  standalone: true,
  imports: [BodyEditorComponent, HeaderEditorComponent],
  templateUrl: './edit-view-page.component.html',
})
export class EditViewPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly tabs = inject(EditTabService);

  readonly expired = signal(false);
  readonly kind = signal<EditTabSeed['kind']>('body');
  readonly title = signal('');
  /** The current value in the seed's own form - body text, or serialized header rows. */
  readonly value = signal('');

  /** Header rows parsed from `value`; empty for a body. */
  readonly rows = computed<readonly HeaderRow[]>(() =>
    this.kind() === 'headers' ? parseHeaderRows(this.value()) ?? [] : []
  );

  private key = '';
  private publisher: ReturnType<EditTabService['publisher']> | null = null;

  constructor() {
    const key = this.route.snapshot.queryParamMap.get('key');
    const seed = key ? this.tabs.readSeed(key) : null;
    // A headers seed that is not the documented row list is as unusable as no seed at all.
    if (!key || !seed || (seed.kind === 'headers' && parseHeaderRows(seed.value) === null)) {
      this.expired.set(true);
      return;
    }
    this.key = key;
    this.kind.set(seed.kind);
    this.title.set(seed.title || (seed.kind === 'headers' ? 'Headers' : 'Body'));
    this.value.set(seed.value);
    this.publisher = this.tabs.publisher(key);
    inject(DestroyRef).onDestroy(() => this.publisher?.close());
  }

  onBodyChange(text: string): void {
    this.apply(text);
  }

  onHeadersChange(rows: readonly HeaderRow[]): void {
    this.apply(serializeHeaderRows(rows));
  }

  private apply(value: string): void {
    this.value.set(value);
    this.publisher?.post({ type: 'value', value });
    this.tabs.store(this.key, { kind: this.kind(), title: this.title(), value });
  }

  done(): void {
    this.publisher?.post({ type: 'closed' });
    window.close();
  }
}
