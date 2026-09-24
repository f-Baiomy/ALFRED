import { Component, OnChanges, SimpleChanges, computed, input, output, signal } from '@angular/core';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { HeaderRow, headersToJsonText, rowsFromHeadersJson, serializeHeaderRows } from '../../shared/utils/header-rows';

export type HeaderEditorView = 'rows' | 'json';

/**
 * Header rows, editable two ways: one input pair per header (the paused-call inspector's rows),
 * or the whole set as a JSON object in the body editor - for pasting forty headers from
 * somewhere else, or a find & replace across all of them.
 *
 * Both views edit the SAME rows and emit `headersChange` with the full row list. Removing a row
 * keeps it, struck through and undoable, rather than deleting it: "did I delete content-type, or
 * was it never there" has to stay answerable. The JSON view shows only what will be sent, so a
 * line deleted there becomes a struck-through row - see rowsFromHeadersJson for the exact rules.
 *
 * Like the body editor, it keeps its own working copy (shown until `headers` next changes from
 * outside - see BodyEditorComponent.ngOnChanges for why that, and not a comparison) and never
 * needs the parent to feed an edit back.
 */
@Component({
  selector: 'app-header-editor',
  standalone: true,
  imports: [BodyEditorComponent],
  templateUrl: './header-editor.component.html',
})
export class HeaderEditorComponent implements OnChanges {
  readonly headers = input.required<readonly HeaderRow[]>();
  readonly readOnly = input(false);
  readonly openInTabLabel = input<string | null>(null);
  /** Which view opens first. The big-tab editor opens on JSON; the inspector on rows. */
  readonly initialView = input<HeaderEditorView>('rows');

  readonly headersChange = output<HeaderRow[]>();
  readonly openInTab = output<void>();

  /** Null until the user picks one, so `initialView` decides until then. */
  private readonly chosenView = signal<HeaderEditorView | null>(null);
  readonly view = computed<HeaderEditorView>(() => this.chosenView() ?? this.initialView());

  private readonly local = signal<readonly HeaderRow[] | null>(null);

  readonly rows = computed<readonly HeaderRow[]>(() => this.local() ?? this.headers());

  /**
   * What the JSON view is showing. Normally the rows, pretty-printed - but while somebody is
   * typing, their own text, for as long as it still describes the rows on screen. Re-printing
   * the canonical form after every keystroke would re-indent under the caret and throw away an
   * invalid half-typed line, which is exactly the text they are in the middle of fixing.
   */
  private readonly jsonDraft = signal<{ readonly text: string; readonly canonical: string; readonly error: string | null } | null>(null);

  private readonly canonicalJson = computed(() => headersToJsonText(this.rows()));

  readonly jsonText = computed(() => {
    const draft = this.jsonDraft();
    return draft && draft.canonical === this.canonicalJson() ? draft.text : this.canonicalJson();
  });

  /** "Not valid JSON - not applied" while the draft does not parse; nothing is emitted meanwhile. */
  readonly jsonError = computed(() => {
    const draft = this.jsonDraft();
    return draft && draft.canonical === this.canonicalJson() ? draft.error : null;
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['headers']) this.local.set(null);
  }

  setView(view: HeaderEditorView): void {
    this.chosenView.set(view);
  }

  private commit(rows: HeaderRow[]): void {
    this.local.set(rows);
    this.headersChange.emit(rows);
  }

  onName(index: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.commit(this.rows().map((row, i) => (i === index ? { ...row, name } : row)));
  }

  onValue(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.commit(this.rows().map((row, i) => (i === index ? { ...row, value } : row)));
  }

  /**
   * Removing keeps the row, struck through and undoable. A row that simply vanished would leave
   * "did I delete content-type, or was it never there" unanswerable.
   */
  toggleRemoved(index: number): void {
    this.commit(
      this.rows()
        .map((row, i) => (i === index ? { ...row, removed: !row.removed } : row))
        // A row added by hand and then removed never existed, so it goes entirely.
        .filter((row) => !(row.added && row.removed))
    );
  }

  addRow(): void {
    this.commit([...this.rows(), { name: '', value: '', removed: false, added: true }]);
  }

  /**
   * An edit in the JSON view. Applied only when it parses to an object of name to value - an
   * invalid draft stays on screen with the reason, and nothing is emitted, so a half-typed brace
   * can never strip every header off a call. A valid edit that changes nothing (whitespace) is
   * not emitted either: it is not an edit.
   */
  onJson(text: string): void {
    const result = rowsFromHeadersJson(text, this.rows());
    if (!result.ok) {
      this.jsonDraft.set({ text, canonical: this.canonicalJson(), error: result.error });
      return;
    }
    this.jsonDraft.set({ text, canonical: headersToJsonText(result.rows), error: null });
    if (serializeHeaderRows(result.rows) !== serializeHeaderRows(this.rows())) this.commit(result.rows);
  }
}
