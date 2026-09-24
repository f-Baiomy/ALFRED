import { Component, ElementRef, OnChanges, SimpleChanges, computed, input, output, signal, viewChild } from '@angular/core';
import { JsonFlatViewComponent, LineTokens } from '../json-flat-view/json-flat-view.component';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { tokenizeJsonText } from '../../shared/utils/json-tokenizer';
import { tokenizeXmlText } from '../../shared/utils/xml-tokenizer';
import { splitTokensIntoLines } from '../../shared/utils/line-tokenizer';
import {
  BodyKind,
  LIVE_CHECK_LIMIT,
  detectBodyKind,
  formatBody,
  minifyBody,
  validateBody,
} from '../../shared/utils/body-format';
import {
  FindOptions,
  buildMatcher,
  findAll,
  literalReplacement,
  markRanges,
  matcherError,
  replaceAll,
  replaceAt,
} from '../../shared/utils/find-replace';

/** Edit it, or read it the way the call cards render a body. */
export type BodyMode = 'edit' | 'inspect';

/**
 * A body editor that looks and colours exactly like the call cards: the paused-call inspector's
 * editor, lifted out so anything that edits a body by hand gets the same one.
 *
 * Two modes. Edit is a textarea over a painted <pre> - the call cards' own tokens, drawn in the
 * same colours underneath transparent glyphs, so the caret and selection are native while the
 * text is highlighted (a textarea cannot colour its own content; this is the only way to have
 * both). Inspect is the call cards' JsonFlatViewComponent itself. Both are fed by ONE tokenized
 * computed, so the coloured text behind the caret and the read-only view can never disagree.
 *
 * The component keeps an edited copy of `value` and emits `valueChange` on every change it makes
 * (typing, Format, Minify, Replace). It does not need the parent to feed that back: the copy is
 * shown until `value` next changes. The moment it does - a big-tab editor pushed an edit, the
 * parent reverted - the new value wins (see ngOnChanges). A parent that does feed the edit back
 * changes `value` to the very text on screen, so the textarea is handed the string it already
 * holds and the caret does not move.
 *
 * Deliberately knows nothing about paused calls, releases or "is this an edit worth sending" -
 * that is the parent's business (see PausedCallsComponent.bodyEdited), driven by valueChange.
 */
@Component({
  selector: 'app-body-editor',
  standalone: true,
  imports: [JsonFlatViewComponent, JsonTokensComponent],
  templateUrl: './body-editor.component.html',
})
export class BodyEditorComponent implements OnChanges {
  readonly value = input.required<string>();
  /** Forces Inspect and hides every control that changes the text. Find still works. */
  readonly readOnly = input(false);
  /** What the thing is called, for the find box's placeholder ("Find in body…"). */
  readonly label = input('Body');
  /** When set, a button with this text emits `openInTab` - the parent decides what that opens. */
  readonly openInTabLabel = input<string | null>(null);

  readonly valueChange = output<string>();
  readonly openInTab = output<void>();

  private readonly bodyArea = viewChild<ElementRef<HTMLTextAreaElement>>('bodyArea');
  private readonly gutter = viewChild<ElementRef<HTMLElement>>('gutter');
  private readonly highlight = viewChild<ElementRef<HTMLElement>>('highlight');

  /**
   * The edited copy - see the class comment. Null means "show `value`". A computed over this
   * rather than an effect that copies `value` in: an effect runs after the first render, so the
   * first frame (and every test) would see an empty editor.
   */
  private readonly local = signal<string | null>(null);

  readonly text = computed(() => this.local() ?? this.value());

  readonly bodyMode = signal<BodyMode>('edit');

  /** A body nobody may change is always shown in Inspect, whatever the Edit/Inspect toggle said. */
  readonly effectiveMode = computed<BodyMode>(() => (this.readOnly() ? 'inspect' : this.bodyMode()));

  /** Classified by the same function the call panel uses, so a payload reads identically in both. */
  readonly bodyKind = computed<BodyKind>(() => detectBodyKind(this.text()));

  readonly validity = computed(() => validateBody(this.text(), this.bodyKind()));

  readonly canFormat = computed(() => formatBody(this.text(), this.bodyKind()) !== null);

  readonly bodyStats = computed(() => {
    const text = this.text();
    if (!text) return '';
    const lines = text.split('\n').length;
    const kb = (new Blob([text]).size / 1024).toFixed(1);
    return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'} · ${kb} KB`;
  });

  /** One number per line, for the gutter beside the textarea. */
  readonly lineNumbers = computed(() => Array.from({ length: this.text().split('\n').length }, (_, i) => i + 1));

  // ---- find & replace ---------------------------------------------------------------------
  //
  // ONE matcher drives the counter, the marks painted behind the caret, the marks in Inspect and
  // what Replace acts on - so "3/12" always counts exactly the things that are highlighted, and
  // Replace always hits the one marked current. Regex and Match case therefore apply to find as
  // well as to replace: they are options of the search, not of the replacement.

  readonly query = signal('');
  readonly matchIndex = signal(0);
  readonly replaceOpen = signal(false);
  readonly replacement = signal('');
  readonly regex = signal(false);
  readonly matchCase = signal(false);
  /** "Replaced 3" after a Replace all - cleared by the next edit to the search. */
  readonly replaceNote = signal('');

  private readonly findOptions = computed<FindOptions>(() => ({ regex: this.regex(), matchCase: this.matchCase() }));

  readonly matcher = computed(() => buildMatcher(this.query(), this.findOptions()));

  /** Why the regex does not compile - shown, and it disables Replace, rather than failing silently. */
  readonly findError = computed(() => matcherError(this.query(), this.findOptions()));

  readonly matches = computed(() => findAll(this.text(), this.matcher()));

  /** The current match, kept in range when an edit or a replace leaves fewer than there were. */
  readonly currentMatch = computed(() => {
    const total = this.matches().length;
    return total === 0 ? -1 : Math.min(this.matchIndex(), total - 1);
  });

  readonly matchLabel = computed(() => {
    if (!this.query()) return '';
    if (this.findError()) return 'bad pattern';
    const total = this.matches().length;
    return total === 0 ? 'no matches' : `${this.currentMatch() + 1}/${total}`;
  });

  readonly canReplace = computed(() => !this.readOnly() && this.matches().length > 0);

  /** Options that change what find means, flagged by the find box while the replace row is shut. */
  readonly optionTags = computed(() => [this.regex() ? '.*' : '', this.matchCase() ? 'Aa' : ''].filter(Boolean));

  /**
   * The same tokenize → mark → split pipeline the call cards run, so neither the editor nor
   * Inspect is a lookalike of that view - they render the very tokens it renders, told which
   * tokenizer to use. Marks come from the shared matcher's ranges over the WHOLE text, so a match
   * that straddles two tokens is painted whole instead of counted and never shown.
   */
  private readonly tokenizedLines = computed<readonly LineTokens[]>(() => {
    const text = this.text();
    const tokens = this.bodyKind() === 'xml' ? tokenizeXmlText(text) : tokenizeJsonText(text);
    const marked = markRanges(tokens, this.matches());
    return splitTokensIntoLines(marked).map((tokensOnLine, index) => ({ index, tokens: tokensOnLine }));
  });

  readonly inspectLines = computed<readonly LineTokens[]>(() =>
    this.effectiveMode() === 'inspect' ? this.tokenizedLines() : []
  );

  /**
   * Whether the editor paints coloured text behind the caret.
   *
   * Off past the same size limit the validity check uses, and for the same reason: re-tokenizing
   * a 6 MB body on every keystroke would make typing unusable, which is a worse failure than
   * monochrome text. Inspect still renders it, because that view is windowed.
   */
  readonly overlayEnabled = computed(() => this.text().length <= LIVE_CHECK_LIMIT);

  readonly editorLines = computed<readonly LineTokens[]>(() =>
    this.effectiveMode() === 'edit' && this.overlayEnabled() ? this.tokenizedLines() : []
  );

  /** Plain text gets no syntax colouring - pretending otherwise would colour a SOAP fault as JSON. */
  readonly inspectVariant = computed(() => (this.bodyKind() === 'text' ? 'plain' : 'json'));

  /** Which match the painted layer and the flat view mark as current. */
  readonly activeMatch = computed(() => this.currentMatch());

  /**
   * Any new `value` from outside replaces the edited copy. ngOnChanges rather than comparing
   * against the value an edit was made from: that comparison cannot tell "unchanged since the
   * edit" from "changed, then changed back", so reverting a one-keystroke edit (value returns to
   * exactly what it was) would leave the edit on screen. ngOnChanges runs synchronously as the
   * binding is set, before this view renders, so there is never a frame of the stale copy.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['value']) this.local.set(null);
  }

  // ---- changing the text ------------------------------------------------------------------

  /** Every change the editor itself makes goes through here, so each one is emitted exactly once. */
  private commit(text: string): void {
    this.local.set(text);
    this.valueChange.emit(text);
  }

  onBodyInput(event: Event): void {
    this.commit((event.target as HTMLTextAreaElement).value);
  }

  format(): void {
    const formatted = formatBody(this.text(), this.bodyKind());
    // Only ever null when the body cannot be parsed, and the button is disabled then - but a
    // keyboard or a race should not blank somebody's body.
    if (formatted !== null) this.commit(formatted);
  }

  minify(): void {
    const minified = minifyBody(this.text(), this.bodyKind());
    if (minified !== null) this.commit(minified);
  }

  /** With Regex off, what was typed is put back literally - `$1` stays `$1`. */
  private replacementText(): string {
    return this.regex() ? this.replacement() : literalReplacement(this.replacement());
  }

  replaceCurrent(): void {
    if (!this.canReplace()) return;
    const at = this.currentMatch();
    const before = this.matches().length;
    this.commit(replaceAt(this.text(), this.matcher(), at, this.replacementText()));
    this.replaceNote.set('');
    // The next match slides into the index just replaced, so staying put IS moving on - unless the
    // replacement itself still matches (x -> xx), in which case step past it rather than replacing
    // the same spot again on the next press.
    if (this.matches().length >= before) this.step(1);
    else this.revealMatch();
  }

  replaceAllMatches(): void {
    if (!this.canReplace()) return;
    const { text, count } = replaceAll(this.text(), this.matcher(), this.replacementText());
    this.commit(text);
    this.matchIndex.set(0);
    this.replaceNote.set(`Replaced ${count}`);
  }

  // ---- searching --------------------------------------------------------------------------

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.matchIndex.set(0);
    this.replaceNote.set('');
    this.revealMatch();
  }

  onReplacement(event: Event): void {
    this.replacement.set((event.target as HTMLInputElement).value);
  }

  onRegex(event: Event): void {
    this.regex.set((event.target as HTMLInputElement).checked);
    this.matchIndex.set(0);
    this.revealMatch();
  }

  onMatchCase(event: Event): void {
    this.matchCase.set((event.target as HTMLInputElement).checked);
    this.matchIndex.set(0);
    this.revealMatch();
  }

  toggleReplace(): void {
    this.replaceOpen.set(!this.replaceOpen());
    this.replaceNote.set('');
  }

  step(delta: number): void {
    const total = this.matches().length;
    if (total === 0) return;
    this.matchIndex.set((this.currentMatch() + delta + total) % total);
    this.revealMatch();
  }

  setBodyMode(mode: BodyMode): void {
    this.bodyMode.set(mode);
    this.revealMatch();
  }

  /**
   * Puts the current match on screen. In Edit that means selecting it in the textarea and
   * scrolling it into view; Inspect does its own highlighting and scrolling.
   *
   * It does NOT focus the textarea. The inspector's version did, which pulled focus out of the
   * find box on the first character typed (the rest of the query then went into the body) and
   * made Enter-for-next-match insert a newline. The painted layer marks the current match
   * anyway, so the selection is a bonus for when the textarea is next focused, not the signal.
   */
  private revealMatch(): void {
    if (this.effectiveMode() !== 'edit') return;
    const at = this.matches()[this.currentMatch()];
    if (at === undefined) return;
    const area = this.bodyArea()?.nativeElement;
    if (!area) return;
    area.setSelectionRange(at.start, at.end);
    // Roughly centre the line: a textarea has no scrollIntoView for a character offset.
    const text = this.text();
    const line = text.slice(0, at.start).split('\n').length - 1;
    const lineHeight = area.scrollHeight / Math.max(1, text.split('\n').length);
    area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 2);
    this.syncGutter();
  }

  /**
   * The gutter and the coloured layer are separate elements, so both have to be told where the
   * textarea scrolled to. The overlay needs BOTH axes: the textarea does not wrap, and a
   * horizontal scroll that moved only the caret would slide the text out from under it.
   */
  syncGutter(): void {
    const area = this.bodyArea()?.nativeElement;
    if (!area) return;
    const gutter = this.gutter()?.nativeElement;
    if (gutter) gutter.scrollTop = area.scrollTop;
    const highlight = this.highlight()?.nativeElement;
    if (highlight) {
      highlight.scrollTop = area.scrollTop;
      highlight.scrollLeft = area.scrollLeft;
    }
  }
}
