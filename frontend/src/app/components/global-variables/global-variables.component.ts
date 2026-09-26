import { Component, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GlobalVariablesService } from '../../core/services/global-variables.service';

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
          @if (variables.error()) { <p class="variables-error">{{ variables.error() }}</p> }
          @for (entry of variables.entries(); track entry.name) {
            <section class="variable-row">
              <div class="variable-row-title"><code>{{ '{{' + entry.name + '}}' }}</code><button type="button" class="variable-delete" (click)="deleteVariable(entry.name)">Delete</button></div>
              <textarea [value]="entry.value" (change)="variables.upsert(entry.name, inputValue($event))" aria-label="Variable value"></textarea>
              <button type="button" class="variable-insert" (click)="editName.set(entry.name); editValue.set(entry.value); editing.set(true)">Edit value</button>
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
    @if (selectionText()) {
      <button class="selection-variable-button" type="button" [style.left.px]="selectionLeft()" [style.top.px]="selectionTop()" (click)="beginSelectionCreate()">+ {{ selectionCanReplace() ? 'Create variable' : 'Save as variable' }}</button>
    }
    @if (selectionEditing()) {
      <div class="variable-modal-backdrop" (click)="selectionEditing.set(false)"><form class="variable-modal create-from-selection" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); saveSelectionCreate()">
        <h2>Create variable from selection</h2><p>{{ selectionCanReplace() ? 'The selected text will be replaced by the token.' : 'This text is read-only. It will stay unchanged; the variable will be ready to use anywhere.' }}</p>
        <label class="selection-value-label">Selected value<textarea [value]="selectionValue()" (input)="selectionValue.set(inputValue($event))"></textarea></label>
        <label class="selection-name-label">Variable name<input [value]="selectionName()" (input)="selectionName.set(inputValue($event))" placeholder="accountId" /></label>
        <p>Token preview: <code>{{ '{{' + (selectionName() || 'name') + '}}' }}</code></p>
        <footer><button type="button" (click)="selectionEditing.set(false)">Cancel</button><button type="submit" class="danger" [disabled]="!validSelectionName()">{{ selectionCanReplace() ? 'Create & replace' : 'Create variable' }}</button></footer>
      </form></div>
    }
    @if (deleting()) {
      <div class="variable-modal-backdrop"><section class="variable-modal" role="dialog" aria-modal="true" aria-labelledby="delete-variable-title">
        <h2 id="delete-variable-title">Delete {{ '{{' + deleting() + '}}' }}?</h2><p>Choose what tokens should resolve to after deletion.</p>
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
  constructor() { this.variables.load(); }
  @HostListener('document:select', ['$event']) onSelect(event: Event): void {
    this.captureSelection(event.target);
    this.updateHighlight(event.target);
  }
  @HostListener('document:mouseup', ['$event']) onMouseUp(event: MouseEvent): void {
    if (event.target instanceof Element && event.target.closest('.selection-variable-button')) return;
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
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (target.closest('.input-variable-hover, .variables-drawer, .variable-modal-backdrop')) return;
    this.updateHighlight(target);
    const names = this.namesIn(target.value);
    if (!names.length) return;
    clearTimeout(this.hoverCloseTimer);
    const rect = target.getBoundingClientRect();
    this.selectionLeft.set(Math.max(8, Math.min(window.innerWidth - 290, rect.left)));
    this.selectionTop.set(Math.min(window.innerHeight - 150, rect.bottom + 8));
    this.hoveredControl.set(target);
  }
  @HostListener('document:mouseout', ['$event']) onMouseOut(event: MouseEvent): void {
    const related = event.relatedTarget;
    if (related instanceof Element && related.closest('.input-variable-hover')) return;
    if (event.target === this.hoveredControl()) this.clearHoveredControl();
  }
  private captureSelection(target: EventTarget | null): void {
    const element = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : document.activeElement;
    if ((element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(element.type))) && !element.closest('app-body-editor')) {
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
  private namesIn(value: string): string[] { return [...new Set([...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g)].map((m) => m[1]))]; }
  hoverLeft(): number { return this.selectionLeft(); }
  hoverTop(): number { return this.selectionTop(); }
  cancelHoverClose(): void { clearTimeout(this.hoverCloseTimer); }
  clearHoveredControl(): void { this.hoverCloseTimer = setTimeout(() => this.hoveredControl.set(null), 220); }
  saveHoveredValue(name: string, event: Event): void { this.variables.upsert(name, this.inputValue(event)); }
  beginSelectionCreate(): void { this.selectionValue.set(this.selectionText()); this.selectionName.set(''); this.closeAutocomplete(); this.selectionEditing.set(true); }
  validSelectionName(): boolean { return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(this.selectionName().trim()); }
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
    this.selectionEditing.set(false);
    this.selectionText.set('');
    this.selectedControl = null;
    this.selectedRange = null;
    this.selectedDomRange = null;
  }
  validName(): boolean { return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(this.editName().trim()); }
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
    const prefix = target.value.slice(0, caret);
    const match = /\{\{([A-Za-z0-9_.-]*)$/.exec(prefix);
    if (!match) return this.closeAutocomplete();
    this.autocompleteControl.set(target);
    this.autocompleteQuery.set(match[1]);
    this.autocompleteRange = { start: caret - match[0].length, end: caret };
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
    const token = `{{${name}}}`;
    const currentValue = control.value;
    const currentRange = control.selectionStart == null ? range : {
      start: control.selectionStart - (control.value.slice(0, control.selectionStart).match(/\{\{([A-Za-z0-9_.-]*)$/)?.[0].length ?? 0),
      end: control.selectionStart,
    };
    const start = Math.max(0, Math.min(currentValue.length, currentRange.start));
    const end = Math.max(start, Math.min(currentValue.length, currentRange.end));
    const alreadyClosed = currentValue.slice(end).startsWith('}}');
    const replaceEnd = end + (alreadyClosed ? 2 : 0);
    control.value = currentValue.slice(0, start) + token + currentValue.slice(replaceEnd);
    control.setSelectionRange(start + token.length, start + token.length);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.focus();
    this.closeAutocomplete();
  }
  private updateHighlight(target: EventTarget | null): void {
    if (!(target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type)))) return;
    // The DOM value is intentionally kept in the native input. Refresh the mirror even when the
    // control is unchanged, otherwise Angular keeps rendering the old token/text split as you type.
    this.highlightValueVersion.update((version) => version + 1);
    // Native selection must remain visible and selectable. Use the mirror only when the caret is
    // collapsed; this keeps the real input text out of the way while preserving drag/keyboard
    // selection for create-variable-from-selection.
    if (target.selectionStart != null && target.selectionEnd != null && target.selectionStart !== target.selectionEnd) {
      return this.setHighlightControl(null);
    }
    if (target.closest('app-body-editor')) return this.setHighlightControl(null);
    if (target.closest('.variable-modal-backdrop, .input-variable-hover')) return this.setHighlightControl(null);
    this.setHighlightControl(this.namesIn(target.value).length ? target : null);
  }
  private setHighlightControl(control: HTMLInputElement | HTMLTextAreaElement | null): void {
    const previous = this.highlightedControl();
    if (previous !== control) previous?.classList.remove('variable-input-text-hidden');
    if (control && previous !== control) control.classList.add('variable-input-text-hidden');
    this.highlightedControl.set(control);
  }
  highlightedParts(): Array<{ text: string; token: boolean }> {
    this.highlightValueVersion();
    const value = this.highlightedControl()?.value ?? '';
    const parts: Array<{ text: string; token: boolean }> = [];
    const pattern = /\{\{[A-Za-z][A-Za-z0-9_.-]*\}\}/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > offset) parts.push({ text: value.slice(offset, start), token: false });
      parts.push({ text: match[0], token: true });
      offset = start + match[0].length;
    }
    if (offset < value.length) parts.push({ text: value.slice(offset), token: false });
    return parts;
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
