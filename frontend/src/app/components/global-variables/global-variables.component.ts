import { Component, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GlobalVariablesService } from '../../core/services/global-variables.service';
import { insertToken, suggestionRange, tokenNames, tokenParts, VARIABLE_NAME } from '../../shared/utils/variable-tokens';

@Component({
  selector: 'app-global-variables',
  standalone: true,
  imports: [FormsModule],
  template: `
    <button class="variables-launch" type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" title="Global variables">{{ open() ? '×' : '{{…}}' }}</button>
    @if (open()) {
      <div class="variables-backdrop" (click)="open.set(false)"></div>
      <aside class="variables-drawer" aria-label="Global variables">
        <header><div><h2>Global variables</h2><p>Use <code>{{ '{{name}}' }}</code> in request fields.</p></div><button type="button" class="variables-close" (click)="open.set(false)">×</button></header>
        <div class="variables-content">
          @if (variables.error()) { <p class="variables-error" role="alert">{{ variables.error() }} <button type="button" (click)="variables.retry()">Retry</button></p> }
          @for (entry of variables.entries(); track entry.name) {
            <section class="variable-row">
              <div class="variable-row-title"><code>{{ '{{' + entry.name + '}}' }}</code><button type="button" class="variable-delete" (click)="deleteVariable(entry.name)">Delete</button></div>
              <textarea [value]="entry.value" (change)="variables.upsert(entry.name, inputValue($event))" [attr.aria-label]="'Value for ' + entry.name" spellcheck="false"></textarea>
            </section>
          } @empty { <p class="variables-empty">No variables yet. Add one to reuse a value across Alfred.</p> }
          <button type="button" class="variable-add" (click)="editName.set(''); editValue.set(''); editing.set(true)">+ Add variable</button>
          @if (editing()) {
            <form class="variable-form" (submit)="$event.preventDefault(); createOrUpdate()">
              <label>Variable name<input name="name" [ngModel]="editName()" (ngModelChange)="editName.set($event)" placeholder="accountId" autocomplete="off" /></label>
              <label>Value<textarea name="value" [ngModel]="editValue()" (ngModelChange)="editValue.set($event)" placeholder="Any text"></textarea></label>
              <div class="variable-form-actions"><button type="button" (click)="editing.set(false)">Cancel</button><button type="submit" [disabled]="!validName()">Save variable</button></div>
            </form>
          }
          @if (variables.saving()) { <p class="variables-status">Saving…</p> }
        </div>
      </aside>
    }
    @if (autocompleteControl() && autocompleteMatches().length) {
      <aside class="variable-suggestions" [style.left.px]="autocompleteLeft()" [style.top.px]="autocompleteTop()" role="listbox" aria-label="Global variable suggestions">
        @for (entry of autocompleteMatches(); track entry.name; let i = $index) {
          <button type="button" role="option" [attr.aria-selected]="i === autocompleteIndex()" [class.active]="i === autocompleteIndex()" (mousedown)="$event.preventDefault()" (click)="chooseVariable(entry.name)">
            <code>{{ '{{' + entry.name + '}}' }}</code><span>{{ entry.value }}</span>
          </button>
        }
      </aside>
    }
    @if (highlightedControl()) {
      <div class="variable-input-highlight" aria-hidden="true" [style]="highlightStyle()"><div class="variable-input-highlight-content" [style.transform]="highlightTransform()">
        @for (part of highlightedParts(); track $index) { <span [class.variable-highlight-token]="part.token">{{ part.text }}</span> }
      </div>
      </div>
    }
    @if (hoveredControl() && hoveredNames().length) {
      <aside class="input-variable-hover" [style.left.px]="hoverLeft()" [style.top.px]="hoverTop()" (mouseenter)="cancelHoverClose()" (mouseleave)="clearHoveredControl()">
        @for (name of hoveredNames(); track name) {
          <label>Value for <code>{{ '{{' + name + '}}' }}</code><textarea [value]="variables.state().variables[name]" (change)="saveHoveredValue(name, $event)"></textarea></label>
        }
      </aside>
    }
    @if (selectionText() && !selectionEditing()) {
      <button class="selection-variable-button" type="button" [style.left.px]="selectionLeft()" [style.top.px]="selectionTop()" (click)="beginSelectionCreate()">+ {{ selectionCanReplace() ? 'Create variable' : 'Save as variable' }}</button>
    }
    @if (selectionEditing()) {
      <div class="variable-modal-backdrop" (click)="cancelSelectionCreate()"><form class="variable-modal create-from-selection" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); saveSelectionCreate()">
        <h2>Create variable from selection</h2><p>{{ selectionCanReplace() ? 'The selected text will be replaced by the token.' : 'This text is read-only. It will stay unchanged; the variable will be ready to use anywhere.' }}</p>
        <label class="selection-value-label">Selected value<textarea [value]="selectionValue()" (input)="selectionValue.set(inputValue($event))"></textarea></label>
        <label class="selection-name-label">Variable name<input [value]="selectionName()" (input)="selectionName.set(inputValue($event))" placeholder="accountId" /></label>
        <p>Token preview: <code>{{ '{{' + (selectionName() || 'name') + '}}' }}</code></p>
        <footer><button type="button" (click)="cancelSelectionCreate()">Cancel</button><button type="submit" class="danger" [disabled]="!validSelectionName()">{{ selectionCanReplace() ? 'Create & replace' : 'Create variable' }}</button></footer>
      </form></div>
    }
    @if (deleting()) {
      <div class="variable-modal-backdrop"><section class="variable-modal" role="dialog" aria-modal="true" aria-labelledby="delete-variable-title">
        <h2 id="delete-variable-title">Delete {{ '{{' + deleting() + '}}' }}?</h2><p>References stay visible in editors. Choose the value used when they run.</p>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'keep'" (change)="deleteMode.set('keep')" /> Keep <code>{{ '{{' + deleting() + '}}' }}</code></label>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'null'" (change)="deleteMode.set('null')" /> Replace with <code>null</code></label>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'custom'" (change)="deleteMode.set('custom')" /> Replace with custom text</label>
        @if (deleteMode() === 'custom') { <textarea [value]="customReplacement()" (input)="customReplacement.set(inputValue($event))" placeholder="Replacement text"></textarea> }
        <footer><button type="button" (click)="deleting.set('')">Cancel</button><button type="button" class="danger" (click)="confirmDelete()">Delete variable</button></footer>
      </section></div>
    }
  `,
})
export class GlobalVariablesComponent {
  readonly variables = inject(GlobalVariablesService);
  private readonly destroyRef = inject(DestroyRef);
  readonly open = signal(false);
  readonly editing = signal(false);
  readonly editName = signal('');
  readonly editValue = signal('');
  readonly deleting = signal('');
  readonly deleteMode = signal<'keep' | 'null' | 'custom'>('keep');
  readonly customReplacement = signal('');
  readonly selectionText = signal('');
  readonly selectionValue = signal('');
  readonly selectionName = signal('');
  readonly selectionEditing = signal(false);
  readonly selectionCanReplace = signal(false);
  readonly selectionLeft = signal(0);
  readonly selectionTop = signal(0);
  private selectedControl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private selectedRange: { start: number; end: number } | null = null;
  private selectedDomRange: Range | null = null;
  readonly autocompleteControl = signal<HTMLInputElement | HTMLTextAreaElement | null>(null);
  readonly autocompleteQuery = signal('');
  readonly autocompleteIndex = signal(0);
  readonly autocompleteLeft = signal(0);
  readonly autocompleteTop = signal(0);
  readonly highlightedControl = signal<HTMLInputElement | HTMLTextAreaElement | null>(null);
  private readonly highlightLayoutVersion = signal(0);
  private readonly highlightValueVersion = signal(0);
  private autocompleteRange: { start: number; end: number } | null = null;
  readonly hoveredControl = signal<HTMLInputElement | HTMLTextAreaElement | null>(null);
  private hoverCloseTimer?: ReturnType<typeof setTimeout>;
  constructor() {
    this.variables.load();
    const onScroll = () => this.highlightLayoutVersion.update((value) => value + 1);
    document.addEventListener('scroll', onScroll, true);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('scroll', onScroll, true);
      clearTimeout(this.hoverCloseTimer);
    });
  }
  @HostListener('document:select', ['$event']) onSelect(event: Event): void {
    this.captureSelection(event.target);
    this.updateHighlight(event.target);
  }
  @HostListener('document:mouseup', ['$event']) onMouseUp(event: MouseEvent): void {
    if (event.target instanceof Element && event.target.closest('.selection-variable-button, .variable-modal-backdrop, .variables-drawer, .variable-suggestions, .input-variable-hover')) return;
    this.captureSelection(event.target);
    this.updateHighlight(event.target);
  }
  @HostListener('document:keyup', ['$event']) onKeyUp(event: KeyboardEvent): void { this.updateAutocomplete(event.target); this.captureSelection(event.target); this.updateHighlight(event.target); }
  @HostListener('document:input', ['$event']) onInput(event: Event): void { this.updateHighlight(event.target); this.updateAutocomplete(event.target); }
  @HostListener('document:focusin', ['$event']) onFocusIn(event: FocusEvent): void { this.updateHighlight(event.target); }
  @HostListener('document:focusout', ['$event']) onFocusOut(event: FocusEvent): void { this.updateHighlight(event.target); }
  @HostListener('window:scroll') onWindowScroll(): void { this.highlightLayoutVersion.update((value) => value + 1); }
  @HostListener('window:resize') onWindowResize(): void { this.highlightLayoutVersion.update((value) => value + 1); }
  @HostListener('document:keydown', ['$event']) onKeyDown(event: KeyboardEvent): void {
    if (!this.autocompleteControl()) return;
    const options = this.autocompleteMatches();
    if (event.key === 'Escape') { this.closeAutocomplete(); return; }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.autocompleteIndex.set((this.autocompleteIndex() + delta + options.length) % options.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.chooseVariable(options[this.autocompleteIndex()].name);
    }
  }
  @HostListener('document:mouseover', ['$event']) onMouseOver(event: MouseEvent): void {
    this.updateHighlight(event.target);
    this.syncHoverCard(event);
  }
  /**
   * The pointer has to be MEASURED against the token, not merely inside the field.
   *
   * The token overlay is `pointer-events:none` (see highlightStyle), so `{{var}}` is never the
   * event target and the DOM cannot tell us the pointer is on it. The only honest test is
   * geometry. Without it the card opened anywhere in a field whose value happened to contain a
   * token - including the empty space past the end of the text, which is where the pointer
   * usually is.
   *
   * This runs on mousemove as well as mouseover because moving WITHIN a single input fires
   * neither: there is no new mouseover until the pointer leaves and re-enters, so a
   * mouseover-only test would let the card stay open after the pointer slid off the token.
   */
  @HostListener('document:mousemove', ['$event']) onMouseMove(event: MouseEvent): void {
    this.syncHoverCard(event);
  }
  private syncHoverCard(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (target.closest('.input-variable-hover, .variables-drawer, .variable-modal-backdrop')) return;
    if (!this.namesIn(target.value).length) return;
    if (!this.pointerOnToken(event.clientX, event.clientY)) {
      if (this.hoveredControl() === target) this.clearHoveredControl();
      return;
    }
    clearTimeout(this.hoverCloseTimer);
    const rect = target.getBoundingClientRect();
    this.selectionLeft.set(Math.max(8, Math.min(window.innerWidth - 290, rect.left)));
    this.selectionTop.set(Math.min(window.innerHeight - 150, rect.bottom + 8));
    this.hoveredControl.set(target);
  }
  private tokenRectsCache?: { control: Element; value: string; version: number; rects: DOMRect[] };
  /**
   * Where the highlighted tokens are on screen, measured only when something that moves them
   * changed - the value, or a scroll/resize (which bumps highlightLayoutVersion). A mousemove
   * handler that measured on every event would force a layout per pointer move.
   */
  private tokenRects(): DOMRect[] {
    const control = this.highlightedControl();
    if (!control) return [];
    const version = this.highlightLayoutVersion() + this.highlightValueVersion();
    const cached = this.tokenRectsCache;
    if (cached && cached.control === control && cached.value === control.value && cached.version === version) {
      return cached.rects;
    }
    const rects = Array.from(document.querySelectorAll('.variable-input-highlight .variable-highlight-token')).map(
      (token) => token.getBoundingClientRect()
    );
    this.tokenRectsCache = { control, value: control.value, version, rects };
    return rects;
  }
  private pointerOnToken(x: number, y: number): boolean {
    return this.tokenRects().some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  }
  @HostListener('document:mouseout', ['$event']) onMouseOut(event: MouseEvent): void {
    const related = event.relatedTarget;
    if (related instanceof Element && related.closest('.input-variable-hover')) return;
    if (event.target === this.hoveredControl()) this.clearHoveredControl();
  }
  private captureSelection(target: EventTarget | null): void {
    // Clicking the floating action transfers focus away from the field. Keep the captured
    // control and range until the dialog confirms or cancels, including keyboard activation.
    if (this.selectionEditing() || (target instanceof Element && target.closest('.selection-variable-button, .variable-modal-backdrop, .variables-drawer, .variable-suggestions, .input-variable-hover'))) return;
    const element = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : document.activeElement;
    if ((element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(element.type))) && !element.readOnly && !element.disabled) {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (start != null && end != null && start !== end) {
        this.selectedControl = element;
        this.selectedRange = { start, end };
        this.selectedDomRange = null;
        this.selectionCanReplace.set(true);
        this.selectionText.set(element.value.slice(start, end));
        const rect = element.getBoundingClientRect();
        this.placeSelectionButton(rect.left, rect.top);
        return;
      }
    }

    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim() || !selection?.rangeCount) { this.selectionText.set(''); return; }
    const range = selection.getRangeAt(0);
    const parent = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (parent?.closest('.variables-drawer, .variable-modal-backdrop, .variable-suggestions')) { this.selectionText.set(''); return; }
    this.selectedControl = null;
    this.selectedRange = null;
    this.selectedDomRange = parent?.closest('[contenteditable="true"], [contenteditable=""]') ? range.cloneRange() : null;
    this.selectionCanReplace.set(!!this.selectedDomRange);
    this.selectionText.set(text);
    const rect = range.getBoundingClientRect();
    this.placeSelectionButton(rect.left, rect.top);
  }
  private placeSelectionButton(left: number, top: number): void {
    this.selectionLeft.set(Math.max(8, Math.min(window.innerWidth - 165, left)));
    this.selectionTop.set(Math.max(42, top));
  }
  hoveredNames(): string[] { return this.namesIn(this.hoveredControl()?.value ?? ''); }
  private namesIn(value: string): string[] { return tokenNames(value); }
  hoverLeft(): number { return this.selectionLeft(); }
  hoverTop(): number { return this.selectionTop(); }
  cancelHoverClose(): void { clearTimeout(this.hoverCloseTimer); }
  clearHoveredControl(): void { this.hoverCloseTimer = setTimeout(() => this.hoveredControl.set(null), 220); }
  saveHoveredValue(name: string, event: Event): void { this.variables.upsert(name, this.inputValue(event)); }
  beginSelectionCreate(): void { this.selectionValue.set(this.selectionText()); this.selectionName.set(''); this.closeAutocomplete(); this.selectionEditing.set(true); }
  validSelectionName(): boolean { return VARIABLE_NAME.test(this.selectionName().trim()); }
  saveSelectionCreate(): void {
    const control = this.selectedControl;
    const range = this.selectedRange;
    const name = this.selectionName().trim();
    if (!this.validSelectionName()) return;
    this.variables.upsert(name, this.selectionValue());
    if (control && range) {
      control.setRangeText(`{{${name}}}`, range.start, range.end, 'end');
      control.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (this.selectedDomRange) {
      this.selectedDomRange.deleteContents();
      this.selectedDomRange.insertNode(document.createTextNode(`{{${name}}}`));
      this.selectedDomRange.commonAncestorContainer.parentElement?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.cancelSelectionCreate();
  }
  cancelSelectionCreate(): void {
    this.selectionEditing.set(false);
    this.selectionText.set('');
    this.selectionCanReplace.set(false);
    this.selectedControl = null;
    this.selectedRange = null;
    this.selectedDomRange = null;
  }
  validName(): boolean { return VARIABLE_NAME.test(this.editName().trim()); }
  createOrUpdate(): void { if (!this.validName()) return; this.variables.upsert(this.editName().trim(), this.editValue()); this.editing.set(false); }
  deleteVariable(name: string): void { this.deleting.set(name); this.deleteMode.set('keep'); this.customReplacement.set(''); }
  confirmDelete(): void {
    const name = this.deleting();
    if (!name) return;
    const replacement = this.deleteMode() === 'keep' ? null : this.deleteMode() === 'null' ? 'null' : this.customReplacement();
    this.variables.remove(name, replacement); this.deleting.set('');
  }
  inputValue(event: Event): string { return (event.target as HTMLTextAreaElement | HTMLInputElement).value; }
  autocompleteMatches(): Array<{ name: string; value: string }> {
    const query = this.autocompleteQuery().toLowerCase();
    return this.variables.entries().filter((entry) => entry.name.toLowerCase().includes(query));
  }
  private updateAutocomplete(target: EventTarget | null): void {
    if (!(target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type)))) return;
    if (target.closest('.variable-modal-backdrop')) return;
    const caret = target.selectionStart;
    if (caret == null) return this.closeAutocomplete();
    const match = suggestionRange(target.value, caret);
    if (!match) return this.closeAutocomplete();
    this.autocompleteControl.set(target);
    this.autocompleteQuery.set(match.query);
    this.autocompleteRange = { start: match.start, end: match.end };
    this.autocompleteIndex.set(0);
    const rect = target.getBoundingClientRect();
    const popupHeight = Math.min(220, this.autocompleteMatches().length * 38 + 12);
    const belowSpace = window.innerHeight - rect.bottom - 8;
    const aboveSpace = rect.top - 8;
    const placeBelow = belowSpace >= popupHeight || belowSpace >= aboveSpace;
    this.autocompleteLeft.set(Math.max(8, Math.min(window.innerWidth - 300, rect.left)));
    this.autocompleteTop.set(placeBelow
      ? Math.max(8, Math.min(window.innerHeight - popupHeight - 8, rect.bottom + 5))
      : Math.max(8, rect.top - popupHeight - 5));
  }
  chooseVariable(name: string): void {
    const control = this.autocompleteControl();
    const range = this.autocompleteRange;
    if (!control || !range) return this.closeAutocomplete();
    const current = control.selectionStart == null ? null : suggestionRange(control.value, control.selectionStart);
    const insertion = insertToken(control.value, current ?? range, name);
    control.value = insertion.value;
    control.setSelectionRange(insertion.caret, insertion.caret);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.focus();
    this.closeAutocomplete();
  }
  private updateHighlight(target: EventTarget | null): void {
    if (!(target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type)))) return;
    // The native field always paints its own text and selection. The overlay only paints a
    // translucent token background, so differences in font rasterization cannot double the text.
    this.highlightValueVersion.update((version) => version + 1);
    // Selection takes precedence over the token decoration.
    if (target.selectionStart != null && target.selectionEnd != null && target.selectionStart !== target.selectionEnd) {
      return this.setHighlightControl(null);
    }
    if (target.closest('app-body-editor')) return this.setHighlightControl(null);
    if (target.closest('.variable-modal-backdrop, .input-variable-hover')) return this.setHighlightControl(null);
    this.setHighlightControl(this.namesIn(target.value).length ? target : null);
  }
  private setHighlightControl(control: HTMLInputElement | HTMLTextAreaElement | null): void {
    this.highlightedControl.set(control);
  }
  highlightedParts(): Array<{ text: string; token: boolean }> {
    this.highlightValueVersion();
    return tokenParts(this.highlightedControl()?.value ?? '');
  }
  highlightStyle(): string {
    this.highlightLayoutVersion();
    const control = this.highlightedControl();
    if (!control) return '';
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    const isArea = control instanceof HTMLTextAreaElement;
    return `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;overflow:hidden;pointer-events:none;z-index:1299;padding:${style.padding};border:${style.borderWidth} solid transparent;font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight};font-style:${style.fontStyle};line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};text-align:${style.textAlign};white-space:${isArea ? 'pre-wrap' : 'pre'};overflow-wrap:${isArea ? 'anywhere' : 'normal'};color:${style.color};display:${isArea ? 'block' : 'flex'};align-items:${isArea ? 'initial' : 'center'};`;
  }
  highlightTransform(): string {
    this.highlightLayoutVersion();
    const control = this.highlightedControl();
    return control ? `translate(${-control.scrollLeft}px, ${-control.scrollTop}px)` : '';
  }
  private closeAutocomplete(): void { this.autocompleteControl.set(null); this.autocompleteQuery.set(''); this.autocompleteRange = null; this.autocompleteIndex.set(0); }
}
