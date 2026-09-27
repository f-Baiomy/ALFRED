import { Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GlobalVariablesService, VariableExport } from '../../core/services/global-variables.service';
import { insertToken, suggestionRange, tokenNames, tokenParts, VARIABLE_NAME } from '../../shared/utils/variable-tokens';
import { resolveDynamicTokens } from '../../shared/utils/dynamic-tokens';

interface LocalVariableHint { readonly name: string; readonly available: boolean; readonly reason?: string; }
interface AutocompleteEntry { readonly name: string; readonly value: string; readonly available: boolean; }
interface VariableSection { readonly key: string; readonly title: string; readonly entries: Array<{ name: string; value: string }>; }
interface UndoAction { readonly name: string; readonly previousValue: string; readonly label: string; }
interface PendingImport { readonly environment: string; readonly variables: Record<string, string>; readonly fallbacks?: Record<string, string>; }

@Component({
  selector: 'app-global-variables',
  standalone: true,
  imports: [FormsModule],
  template: `
    <button class="variables-launch" type="button" (click)="toggleOpen()" [attr.aria-expanded]="open()" title="Global variables">
      {{ open() ? '×' : '{{…}}' }}
      @if (!open() && badgeCount() > 0) { <span class="variables-launch-badge">{{ badgeCount() }}</span> }
    </button>
    @if (open()) {
      <div class="dialog-backdrop variables-backdrop" (click)="open.set(false)"></div>
      <aside class="variables-drawer" aria-label="Global variables">
        <header><div><h2>Global variables</h2><p>Use <code>{{ '{{name}}' }}</code> in request fields.</p></div><button type="button" class="variables-close" (click)="open.set(false)">×</button></header>
        <div class="variables-content">
          @if (variables.error()) { <p class="dialog-error-note" role="alert">{{ variables.error() }} <button type="button" (click)="variables.retry()">Retry</button></p> }

          <div class="variables-env-bar">
            @for (env of environments(); track env) {
              <button type="button" class="variables-env-chip" [class.active]="env === activeEnvironment()" (click)="switchEnv(env)">
                {{ env }}
                @if (environments().length > 1 && env !== activeEnvironment()) {
                  <span (click)="$event.stopPropagation(); confirmDeleteEnv(env)">&nbsp;×</span>
                }
              </button>
            }
            <button type="button" class="variables-env-chip variables-env-add" (click)="openCreateEnv()">+ New environment</button>
          </div>
          <div class="variables-env-actions">
            <button type="button" class="dialog-btn secondary" (click)="openImport()">Import</button>
            <button type="button" class="dialog-btn secondary" (click)="exportCurrent()">Export</button>
          </div>

          @if (showFilter()) {
            <input class="variables-filter" type="search" placeholder="Filter variables" [ngModel]="filterQuery()" (ngModelChange)="filterQuery.set($event)" />
          }

          @for (section of groupedSections(); track section.key) {
            <p class="variables-section-title">{{ section.title }}</p>
            @for (entry of section.entries; track entry.name) {
              <section class="variable-row" [class.flash]="flashedNames().has(entry.name)" [attr.data-variable-row]="entry.name">
                <div class="variable-row-title">
                  <div class="variable-row-title-main"><code>{{ '{{' + entry.name + '}}' }}</code></div>
                  <div class="variable-row-actions">
                    @if (section.key !== 'DELETED') {
                      @if (isMasked(entry.name)) {
                        <button type="button" class="variable-icon-btn" title="Reveal value" (click)="toggleReveal(entry.name)">👁</button>
                      }
                      <button type="button" class="variable-icon-btn" title="Copy value" (click)="copyValue(entry.value)">⧉</button>
                      <button type="button" class="variable-icon-btn" [class.active]="isExplicitSecret(entry.name)" title="Mark as secret" (click)="toggleSecret(entry.name)">🔒</button>
                      <button type="button" class="variable-icon-btn danger" title="Delete" (click)="deleteVariable(entry.name)">✕</button>
                    }
                  </div>
                </div>
                <p class="variable-row-meta">
                  @if (section.key === 'CAPTURE' && ruleNameOf(entry.name); as ruleName) { <span class="variable-source-pill">rule "{{ ruleName }}"</span> }
                  @if (updatedAtOf(entry.name); as ts) { <span>{{ relativeTime(ts) }}</span> }
                </p>
                @if (section.key === 'DELETED') {
                  <p class="variable-resolved-preview">Fallback: {{ entry.value }}</p>
                } @else if (isMasked(entry.name) && !isRevealed(entry.name)) {
                  <div class="variable-value-masked">••••••••••••</div>
                } @else {
                  <textarea [value]="entry.value" (change)="onRowValueChange(entry.name, $event)" [attr.aria-label]="'Value for ' + entry.name" spellcheck="false"></textarea>
                  @if (resolvedPreview(entry.value); as preview) {
                    @if (preview !== entry.value) { <p class="variable-resolved-preview">Resolves to: {{ isMasked(entry.name) ? '••••••••' : preview }}</p> }
                  }
                }
              </section>
            }
          } @empty { <p class="variables-empty">No variables yet. Add one to reuse a value across Alfred.</p> }

          <button type="button" class="variable-add" (click)="beginAdd()">+ Add variable</button>
          @if (editing()) {
            <form class="variable-form" (submit)="$event.preventDefault(); createOrUpdate()" (keydown.escape)="editing.set(false)">
              <label>Variable name<input #nameField name="name" [ngModel]="editName()" (ngModelChange)="editName.set($event)" (keydown.enter)="$event.preventDefault(); createOrUpdate()" placeholder="accountId" autocomplete="off" /></label>
              @if (duplicateNameWarning(); as warning) { <p class="variable-name-warning">{{ warning }}</p> }
              <label>Value<textarea name="value" [ngModel]="editValue()" (ngModelChange)="editValue.set($event)" placeholder="Any text"></textarea></label>
              <div class="variable-form-actions"><button type="button" class="dialog-btn secondary" (click)="editing.set(false)">Cancel</button><button type="submit" class="dialog-btn primary" [disabled]="!validName()">Save variable</button></div>
            </form>
          }
          @if (variables.saving()) { <p class="variables-status">Saving…</p> }
        </div>
      </aside>
    }
    @if (autocompleteControl() && autocompleteMatches().length) {
      <aside class="variable-suggestions" [style.left.px]="autocompleteLeft()" [style.top.px]="autocompleteTop()" role="listbox" aria-label="Global variable suggestions">
        @for (entry of autocompleteMatches(); track entry.name; let i = $index) {
          <button type="button" role="option" [attr.aria-selected]="i === autocompleteIndex()" [class.active]="i === autocompleteIndex()" [class.unavailable]="!entry.available" [disabled]="!entry.available" (mousedown)="$event.preventDefault()" (click)="chooseVariable(entry.name)">
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
          <label>Value for <code>{{ '{{' + name + '}}' }}</code>
            @if (isMasked(name) && !isRevealed(name)) {
              <div class="variable-value-masked">•••••••••••• <button type="button" class="variable-icon-btn" (click)="toggleReveal(name)">Reveal</button></div>
            } @else {
              <textarea [value]="variables.state().variables[name]" (change)="saveHoveredValue(name, $event)"></textarea>
              @if (resolvedPreview(variables.state().variables[name]); as preview) {
                @if (preview !== variables.state().variables[name]) { <p class="variable-resolved-preview">Resolves to: {{ preview }}</p> }
              }
            }
          </label>
        }
      </aside>
    }
    @if (selectionText() && !selectionEditing()) {
      <button class="selection-variable-button" type="button" [style.left.px]="selectionLeft()" [style.top.px]="selectionTop()" (click)="beginSelectionCreate()">+ {{ selectionCanReplace() ? 'Create variable' : 'Save as variable' }}</button>
    }
    @if (selectionEditing()) {
      <div class="dialog-backdrop" (click)="cancelSelectionCreate()"><form class="dialog-card variable-modal create-from-selection" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); saveSelectionCreate()">
        <h2>Create variable from selection</h2><p>{{ selectionCanReplace() ? 'The selected text will be replaced by the token.' : 'This text is read-only. It will stay unchanged; the variable will be ready to use anywhere.' }}</p>
        <label class="selection-value-label">Selected value<textarea [value]="selectionValue()" (input)="selectionValue.set(inputValue($event))"></textarea></label>
        <label class="selection-name-label">Variable name<input [value]="selectionName()" (input)="selectionName.set(inputValue($event))" placeholder="accountId" /></label>
        <p>Token preview: <code>{{ '{{' + (selectionName() || 'name') + '}}' }}</code></p>
        <footer><button type="button" class="dialog-btn secondary" (click)="cancelSelectionCreate()">Cancel</button><button type="submit" class="dialog-btn danger" [disabled]="!validSelectionName()">{{ selectionCanReplace() ? 'Create & replace' : 'Create variable' }}</button></footer>
      </form></div>
    }
    @if (deleting()) {
      <div class="dialog-backdrop"><section class="dialog-card variable-modal" role="dialog" aria-modal="true" aria-labelledby="delete-variable-title">
        <h2 id="delete-variable-title">Delete {{ '{{' + deleting() + '}}' }}?</h2><p>References stay visible in editors. Choose the value used when they run.</p>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'keep'" (change)="deleteMode.set('keep')" /> Keep <code>{{ '{{' + deleting() + '}}' }}</code></label>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'null'" (change)="deleteMode.set('null')" /> Replace with <code>null</code></label>
        <label><input type="radio" name="delete-mode" [checked]="deleteMode() === 'custom'" (change)="deleteMode.set('custom')" /> Replace with custom text</label>
        @if (deleteMode() === 'custom') { <textarea [value]="customReplacement()" (input)="customReplacement.set(inputValue($event))" placeholder="Replacement text"></textarea> }
        <footer><button type="button" class="dialog-btn secondary" (click)="deleting.set('')">Cancel</button><button type="button" class="dialog-btn danger" (click)="confirmDelete()">Delete variable</button></footer>
      </section></div>
    }
    @if (deletingEnvironment()) {
      <div class="dialog-backdrop"><section class="dialog-card variable-modal" role="dialog" aria-modal="true">
        <h2>Delete environment "{{ deletingEnvironment() }}"?</h2>
        <p class="dialog-warning-note">Its variables and fallbacks are removed. This cannot be undone.</p>
        <footer><button type="button" class="dialog-btn secondary" (click)="deletingEnvironment.set('')">Cancel</button><button type="button" class="dialog-btn danger" (click)="doDeleteEnv()">Delete environment</button></footer>
      </section></div>
    }
    @if (creatingEnvironment()) {
      <div class="dialog-backdrop" (click)="cancelCreateEnv()"><section class="dialog-card variables-env-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <h2>New environment</h2>
        <label>Name<input [value]="newEnvName()" (input)="newEnvName.set(inputValue($event))" placeholder="Staging" autocomplete="off" /></label>
        <label>Copy variables from
          <select [ngModel]="newEnvCopyFrom()" (ngModelChange)="newEnvCopyFrom.set($event)">
            <option value="">None</option>
            @for (env of environments(); track env) { <option [value]="env">{{ env }}</option> }
          </select>
        </label>
        <footer><button type="button" class="dialog-btn secondary" (click)="cancelCreateEnv()">Cancel</button><button type="button" class="dialog-btn primary" [disabled]="!validNewEnvName()" (click)="confirmCreateEnv()">Create</button></footer>
      </section></div>
    }
    @if (importing()) {
      <div class="dialog-backdrop" (click)="cancelImport()"><section class="dialog-card variables-import-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <h2>Import variables</h2>
        <p>An Alfred variables export, or a Postman environment file (.json).</p>
        <input type="file" accept="application/json" (change)="onImportFile($event)" />
        @if (importFileError()) { <p class="dialog-error-note">{{ importFileError() }}</p> }
        @if (pendingImport(); as ready) {
          <p class="dialog-warning-note">Ready to import {{ objectSize(ready.variables) }} variable(s) into "{{ ready.environment }}".</p>
          <div class="import-mode-choice">
            <label><input type="radio" name="import-mode" [checked]="importMode() === 'MERGE'" (change)="importMode.set('MERGE')" /> Merge</label>
            <label><input type="radio" name="import-mode" [checked]="importMode() === 'REPLACE'" (change)="importMode.set('REPLACE')" /> Replace</label>
          </div>
        }
        <footer><button type="button" class="dialog-btn secondary" (click)="cancelImport()">Cancel</button><button type="button" class="dialog-btn primary" [disabled]="!pendingImport()" (click)="confirmImport()">Import</button></footer>
      </section></div>
    }
    @if (lastUndo(); as action) {
      <div class="variable-undo-toast" role="status">
        <span>{{ action.label }}</span>
        <button type="button" (click)="undo()">Undo</button>
      </div>
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
  readonly hoveredName = signal('');
  private hoverCloseTimer?: ReturnType<typeof setTimeout>;

  // ---- B3/B4: filter, masking, grouping ----
  readonly filterQuery = signal('');
  readonly revealedNames = signal<ReadonlySet<string>>(new Set());
  readonly flashedNames = signal<ReadonlySet<string>>(new Set());
  readonly badgeCount = signal(0);
  private readonly clockTick = signal(0);
  private clockInterval?: ReturnType<typeof setInterval>;

  // ---- C2: environments ----
  readonly creatingEnvironment = signal(false);
  readonly newEnvName = signal('');
  readonly newEnvCopyFrom = signal('');
  readonly deletingEnvironment = signal('');
  readonly importing = signal(false);
  readonly importMode = signal<'MERGE' | 'REPLACE'>('MERGE');
  readonly importFileError = signal('');
  readonly pendingImport = signal<PendingImport | null>(null);

  // ---- C4: undo ----
  readonly lastUndo = signal<UndoAction | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;

  readonly environments = computed(() => this.variables.state().environments ?? ['Default']);
  readonly activeEnvironment = computed(() => this.variables.state().activeEnvironment ?? 'Default');
  readonly showFilter = computed(() => this.variables.entries().length > 8);

  readonly groupedSections = computed<VariableSection[]>(() => {
    const query = this.filterQuery().trim().toLowerCase();
    const state = this.variables.state();
    const sources = state.sources ?? {};
    const matches = (name: string) => !query || name.toLowerCase().includes(query);
    const byKind: Record<'CAPTURE' | 'MANUAL' | 'IMPORT', Array<{ name: string; value: string }>> = { CAPTURE: [], MANUAL: [], IMPORT: [] };
    for (const entry of this.variables.entries()) {
      if (!matches(entry.name)) continue;
      const kind = sources[entry.name]?.kind ?? 'MANUAL';
      byKind[kind].push(entry);
    }
    const fallbacks = state.fallbacks ?? {};
    const deleted = Object.keys(fallbacks)
      .filter((name) => !(name in state.variables) && matches(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, value: fallbacks[name] }));
    return ([
      { key: 'CAPTURE', title: 'Captured by rules', entries: byKind.CAPTURE },
      { key: 'MANUAL', title: 'Set by hand', entries: byKind.MANUAL },
      { key: 'IMPORT', title: 'Imported', entries: byKind.IMPORT },
      { key: 'DELETED', title: 'Deleted, fallback still applies', entries: deleted },
    ] satisfies VariableSection[]).filter((section) => section.entries.length > 0);
  });

  constructor() {
    this.variables.load();
    this.variables.watchForChanges();
    const onScroll = () => this.highlightLayoutVersion.update((value) => value + 1);
    document.addEventListener('scroll', onScroll, true);
    this.clockInterval = setInterval(() => this.clockTick.update((value) => value + 1), 30_000);
    // Live WS-driven change: flash the row while the drawer is open, otherwise bump the launch
    // tab's badge until the user opens it (B3/B4). Every access is optional-chained because
    // several specs provide a minimal service mock without these members.
    effect(() => {
      const changed = this.variables.lastChangedNames?.() ?? [];
      if (!changed.length) return;
      if (untracked(() => this.open())) this.flashedNames.set(new Set(changed));
      else this.badgeCount.update((count) => count + changed.length);
    }, { allowSignalWrites: true });
    // focusVariable(name) (contract section 6) - opens the drawer scrolled to and flashing that row.
    effect(() => {
      const request = this.variables.focusRequest?.();
      if (!request) return;
      this.open.set(true);
      this.badgeCount.set(0);
      this.flashedNames.set(new Set([request.name]));
      setTimeout(() => {
        const row = document.querySelector(`[data-variable-row="${cssEscape(request.name)}"]`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 30);
    }, { allowSignalWrites: true });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('scroll', onScroll, true);
      clearTimeout(this.hoverCloseTimer);
      clearTimeout(this.undoTimer);
      clearInterval(this.clockInterval);
    });
  }
  @HostListener('document:select', ['$event']) onSelect(event: Event): void {
    this.captureSelection(event.target);
    this.updateHighlight(event.target);
  }
  @HostListener('document:mouseup', ['$event']) onMouseUp(event: MouseEvent): void {
    if (event.target instanceof Element && event.target.closest('.selection-variable-button, .dialog-backdrop, .variables-drawer, .variable-suggestions, .input-variable-hover')) return;
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
      if (!options[this.autocompleteIndex()]?.available) return;
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
    if (target.closest('.input-variable-hover, .variables-drawer, .dialog-backdrop')) return;
    const name = this.tokenAtPointer(event.clientX, event.clientY);
    if (!name || name.startsWith('this.') || !(name in this.variables.state().variables)) {
      if (this.hoveredControl() === target) this.clearHoveredControl();
      return;
    }
    clearTimeout(this.hoverCloseTimer);
    const rect = target.getBoundingClientRect();
    this.selectionLeft.set(Math.max(8, Math.min(window.innerWidth - 290, rect.left)));
    this.selectionTop.set(Math.min(window.innerHeight - 150, rect.bottom + 8));
    this.hoveredName.set(name);
    this.hoveredControl.set(target);
  }
  private tokenRectsCache?: { control: Element; value: string; version: number; rects: Array<{ rect: DOMRect; name: string }> };
  /**
   * Where the highlighted tokens are on screen, measured only when something that moves them
   * changed - the value, or a scroll/resize (which bumps highlightLayoutVersion). A mousemove
   * handler that measured on every event would force a layout per pointer move.
   */
  private tokenRects(): Array<{ rect: DOMRect; name: string }> {
    const control = this.highlightedControl();
    if (!control) return [];
    const version = this.highlightLayoutVersion() + this.highlightValueVersion();
    const cached = this.tokenRectsCache;
    if (cached && cached.control === control && cached.value === control.value && cached.version === version) {
      return cached.rects;
    }
    const rects = Array.from(document.querySelectorAll('.variable-input-highlight .variable-highlight-token')).map(
      (token) => ({ rect: token.getBoundingClientRect(), name: tokenNames(token.textContent ?? '')[0] ?? '' })
    );
    this.tokenRectsCache = { control, value: control.value, version, rects };
    return rects;
  }
  private tokenAtPointer(x: number, y: number): string {
    return this.tokenRects().find(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)?.name ?? '';
  }
  @HostListener('document:mouseout', ['$event']) onMouseOut(event: MouseEvent): void {
    const related = event.relatedTarget;
    if (related instanceof Element && related.closest('.input-variable-hover')) return;
    if (event.target === this.hoveredControl()) this.clearHoveredControl();
  }
  private captureSelection(target: EventTarget | null): void {
    // Clicking the floating action transfers focus away from the field. Keep the captured
    // control and range until the dialog confirms or cancels, including keyboard activation.
    if (this.selectionEditing() || (target instanceof Element && target.closest('.selection-variable-button, .dialog-backdrop, .variables-drawer, .variable-suggestions, .input-variable-hover'))) return;
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
    if (parent?.closest('.variables-drawer, .dialog-backdrop, .variable-suggestions')) { this.selectionText.set(''); return; }
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
  hoveredNames(): string[] { return this.hoveredName() ? [this.hoveredName()] : []; }
  private namesIn(value: string): string[] { return tokenNames(value); }
  hoverLeft(): number { return this.selectionLeft(); }
  hoverTop(): number { return this.selectionTop(); }
  cancelHoverClose(): void { clearTimeout(this.hoverCloseTimer); }
  clearHoveredControl(): void { this.hoverCloseTimer = setTimeout(() => { this.hoveredControl.set(null); this.hoveredName.set(''); }, 220); }
  saveHoveredValue(name: string, event: Event): void { this.editVariableValue(name, this.inputValue(event)); }
  beginSelectionCreate(): void { this.selectionValue.set(this.selectionText()); this.selectionName.set(''); this.closeAutocomplete(); this.selectionEditing.set(true); }
  validSelectionName(): boolean { return VARIABLE_NAME.test(this.selectionName().trim()) && !this.selectionName().trim().startsWith('this.'); }
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
  validName(): boolean { return VARIABLE_NAME.test(this.editName().trim()) && !this.editName().trim().startsWith('this.'); }
  /** Only warns while adding a NEW variable - the "+ Add variable" form is the only place a name can collide, since existing rows edit their own value in place. Doesn't block saving: upsert-by-name overwriting is the intended behaviour, this is just a heads-up. */
  readonly duplicateNameWarning = computed<string>(() => {
    const name = this.editName().trim();
    if (!name) return '';
    const value = this.variables.state().variables[name];
    if (value === undefined) return '';
    return `"${name}" exists (current: ${value.slice(0, 40)}…) — Save will overwrite`;
  });
  /** Opening always refetches - a proxy GLOBAL promotion (or another tab) may have changed the store since the last load, and load() alone runs once per app lifetime. */
  toggleOpen(): void {
    const next = !this.open();
    this.open.set(next);
    if (next) {
      this.variables.refresh();
      this.badgeCount.set(0);
    }
  }
  beginAdd(): void {
    this.editName.set('');
    this.editValue.set('');
    this.editing.set(true);
    setTimeout(() => {
      (document.querySelector('.variable-form input[name="name"]') as HTMLInputElement | null)?.focus();
    }, 0);
  }
  createOrUpdate(): void {
    if (!this.validName()) return;
    const name = this.editName().trim();
    this.editVariableValue(name, this.editValue());
    this.editing.set(false);
  }
  /** Shared by the add form, inline row edits and the hover-card quick edit - captures the
   *  previous value for the undo toast (C4) only when this actually overwrites an existing one. */
  private editVariableValue(name: string, value: string): void {
    const existed = Object.prototype.hasOwnProperty.call(this.variables.state().variables, name);
    const previousValue = this.variables.state().variables[name];
    this.variables.upsert(name, value);
    if (existed && previousValue !== value) this.pushUndo(name, previousValue, `Updated {{${name}}}`);
  }
  onRowValueChange(name: string, event: Event): void { this.editVariableValue(name, this.inputValue(event)); }
  deleteVariable(name: string): void { this.deleting.set(name); this.deleteMode.set('keep'); this.customReplacement.set(''); }
  confirmDelete(): void {
    const name = this.deleting();
    if (!name) return;
    const previousValue = this.variables.state().variables[name] ?? '';
    const replacement = this.deleteMode() === 'keep' ? null : this.deleteMode() === 'null' ? 'null' : this.customReplacement();
    this.variables.remove(name, replacement);
    this.deleting.set('');
    this.pushUndo(name, previousValue, `Deleted {{${name}}}`);
  }
  inputValue(event: Event): string { return (event.target as HTMLTextAreaElement | HTMLInputElement).value; }

  // ---- B4: masking, reveal, copy, secret toggle, relative time ----
  isExplicitSecret(name: string): boolean { return (this.variables.state().secrets ?? []).includes(name); }
  isMasked(name: string): boolean { return this.variables.isSecret?.(name) ?? false; }
  isRevealed(name: string): boolean { return this.revealedNames().has(name); }
  toggleReveal(name: string): void {
    const next = new Set(this.revealedNames());
    if (next.has(name)) next.delete(name); else next.add(name);
    this.revealedNames.set(next);
  }
  toggleSecret(name: string): void { this.variables.setSecret(name, !this.isExplicitSecret(name)); }
  copyValue(value: string): void { navigator.clipboard?.writeText(value)?.catch(() => {}); }
  ruleNameOf(name: string): string | null { return this.variables.state().sources?.[name]?.ruleName ?? null; }
  updatedAtOf(name: string): number | undefined { return this.variables.state().updatedAt?.[name]; }
  relativeTime(ts: number | undefined): string {
    this.clockTick();
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 60_000) return 'just now';
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  /** D4 preview: resolved value shown next to the raw one, using the shared dynamic-token
   *  resolver so it previews exactly what a resend/proxy would send. */
  resolvedPreview(value: string): string {
    return resolveDynamicTokens(value, (name) => this.variables.state().variables[name]);
  }
  objectSize(value: Record<string, unknown>): number { return Object.keys(value).length; }

  // ---- C2: environments ----
  switchEnv(name: string): void { if (name !== this.activeEnvironment()) this.variables.switchEnvironment(name); }
  openCreateEnv(): void { this.newEnvName.set(''); this.newEnvCopyFrom.set(this.activeEnvironment()); this.creatingEnvironment.set(true); }
  cancelCreateEnv(): void { this.creatingEnvironment.set(false); }
  validNewEnvName(): boolean { return /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(this.newEnvName().trim()); }
  confirmCreateEnv(): void {
    if (!this.validNewEnvName()) return;
    this.variables.createEnvironment(this.newEnvName().trim(), this.newEnvCopyFrom() || undefined);
    this.creatingEnvironment.set(false);
  }
  confirmDeleteEnv(name: string): void { this.deletingEnvironment.set(name); }
  doDeleteEnv(): void {
    const name = this.deletingEnvironment();
    if (!name) return;
    this.variables.deleteEnvironment(name);
    this.deletingEnvironment.set('');
  }
  exportCurrent(): void {
    this.variables.exportEnvironment(this.activeEnvironment(), (payload) => this.downloadJson(`${payload.name || 'variables'}.json`, payload));
  }
  private downloadJson(filename: string, payload: VariableExport): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  openImport(): void { this.importMode.set('MERGE'); this.pendingImport.set(null); this.importFileError.set(''); this.importing.set(true); }
  cancelImport(): void { this.importing.set(false); this.pendingImport.set(null); this.importFileError.set(''); }
  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = this.normalizeImportPayload(String(reader.result ?? ''));
      if (!parsed) { this.importFileError.set('Unrecognized file — expected an Alfred variables export or a Postman environment file.'); this.pendingImport.set(null); return; }
      this.importFileError.set('');
      this.pendingImport.set(parsed);
    };
    reader.readAsText(file);
    input.value = '';
  }
  /** Accepts the contract export shape ({environment, variables, fallbacks?}) as-is, and converts
   *  a Postman environment file ({name, values:[{key,value,enabled}]}) client-side (C2). */
  private normalizeImportPayload(raw: string): PendingImport | null {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['environment'] === 'string' && obj['variables'] && typeof obj['variables'] === 'object') {
      return {
        environment: obj['environment'] as string,
        variables: obj['variables'] as Record<string, string>,
        fallbacks: (obj['fallbacks'] as Record<string, string> | undefined),
      };
    }
    if (Array.isArray(obj['values'])) {
      const variables: Record<string, string> = {};
      for (const entry of obj['values'] as Array<Record<string, unknown>>) {
        if (entry && typeof entry['key'] === 'string' && entry['enabled'] !== false) {
          variables[entry['key'] as string] = String(entry['value'] ?? '');
        }
      }
      const environment = typeof obj['name'] === 'string' && obj['name'] ? obj['name'] as string : 'Imported';
      return { environment, variables };
    }
    return null;
  }
  confirmImport(): void {
    const pending = this.pendingImport();
    if (!pending) return;
    this.variables.import({ ...pending, mode: this.importMode() });
    this.cancelImport();
  }

  // ---- C4: undo ----
  private pushUndo(name: string, previousValue: string, label: string): void {
    clearTimeout(this.undoTimer);
    this.lastUndo.set({ name, previousValue, label });
    this.undoTimer = setTimeout(() => this.lastUndo.set(null), 8000);
  }
  undo(): void {
    const action = this.lastUndo();
    if (!action) return;
    this.variables.upsert(action.name, action.previousValue);
    this.lastUndo.set(null);
    clearTimeout(this.undoTimer);
  }

  /** Scope-aware autocomplete (C3): the focused input may carry a JSON
   *  `data-local-variables='[{"name":"token","available":true,"reason":""}]'` attribute (contract
   *  section 6) - those list first as `this.<name>`, greyed out and not insertable when
   *  unavailable. Falls back to plain global-variable matches otherwise. */
  autocompleteMatches(): AutocompleteEntry[] {
    const query = this.autocompleteQuery().toLowerCase();
    const control = this.autocompleteControl();
    const locals = this.localVariableHints(control)
      .map((hint) => ({ name: `this.${hint.name}`, value: hint.available ? 'Rule variable' : (hint.reason || 'Not available here'), available: hint.available }))
      .filter((entry) => entry.name.toLowerCase().includes(query));
    if (query.startsWith('this.')) return locals;
    const globals = this.variables.entries()
      .filter((entry) => entry.name.toLowerCase().includes(query))
      .map((entry) => ({ name: entry.name, value: this.isMasked(entry.name) ? '••••••••' : entry.value, available: true }));
    return [...locals, ...globals];
  }
  private localVariableHints(control: HTMLInputElement | HTMLTextAreaElement | null): LocalVariableHint[] {
    const attr = control?.closest('[data-local-variables]')?.getAttribute('data-local-variables');
    if (!attr) return [];
    try {
      const parsed = JSON.parse(attr);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof entry['name'] === 'string')
        .map((entry) => ({ name: entry['name'] as string, available: entry['available'] !== false, reason: typeof entry['reason'] === 'string' ? entry['reason'] : undefined }));
    } catch {
      return [];
    }
  }
  private updateAutocomplete(target: EventTarget | null): void {
    if (!(target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type)))) return;
    if (target.closest('.dialog-backdrop')) return;
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
    const match = this.autocompleteMatches().find((entry) => entry.name === name);
    if (match && !match.available) return;
    const current = control.selectionStart == null ? null : suggestionRange(control.value, control.selectionStart);
    const at = current ?? range;
    const insertion = insertToken(control.value, at, name);
    // A body editor owns its textarea through [value], so it applies the insertion itself - see
    // BodyEditorComponent.onVariableInsert. Writing control.value directly races the binding that
    // feeds the edit straight back, and the caret then lands wherever the browser puts it rather
    // than at the token that was just inserted.
    if (control.closest('app-body-editor')) {
      control.dispatchEvent(new CustomEvent('variableinsert', {
        bubbles: true,
        detail: insertion,
      }));
      control.focus();
      this.closeAutocomplete();
      return;
    }
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
    if (target.closest('.dialog-backdrop, .input-variable-hover')) return this.setHighlightControl(null);
    this.setHighlightControl(this.namesIn(target.value).length ? target : null);
  }
  private setHighlightControl(control: HTMLInputElement | HTMLTextAreaElement | null): void {
    this.highlightedControl.set(control);
  }
  /** Template-called every change detection, so these three are computed() rather than plain
   *  methods - each recomputes only when the signals it actually reads change, instead of on
   *  every CD tick (highlightStyle/highlightTransform both call getBoundingClientRect/
   *  getComputedStyle, which force a layout). */
  readonly highlightedParts = computed<Array<{ text: string; token: boolean }>>(() => {
    this.highlightValueVersion();
    return tokenParts(this.highlightedControl()?.value ?? '');
  });
  readonly highlightStyle = computed<string>(() => {
    this.highlightLayoutVersion();
    const control = this.highlightedControl();
    if (!control) return '';
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    const isArea = control instanceof HTMLTextAreaElement;
    // z-index 150: above ordinary page content and Alfred dialog cards (z:101), below the
    // suggestion popup/hover card (z:210+) so those still layer correctly over a highlighted field.
    return `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;overflow:hidden;pointer-events:none;z-index:150;padding:${style.padding};border:${style.borderWidth} solid transparent;font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight};font-style:${style.fontStyle};line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};text-align:${style.textAlign};white-space:${isArea ? 'pre-wrap' : 'pre'};overflow-wrap:${isArea ? 'anywhere' : 'normal'};color:${style.color};display:${isArea ? 'block' : 'flex'};align-items:${isArea ? 'initial' : 'center'};`;
  });
  readonly highlightTransform = computed<string>(() => {
    this.highlightLayoutVersion();
    const control = this.highlightedControl();
    return control ? `translate(${-control.scrollLeft}px, ${-control.scrollTop}px)` : '';
  });
  private closeAutocomplete(): void { this.autocompleteControl.set(null); this.autocompleteQuery.set(''); this.autocompleteRange = null; this.autocompleteIndex.set(0); }
}

/** CSS.escape isn't available in every test environment; this covers the characters a variable
 *  name (VARIABLE_NAME) can actually contain. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, '\\$&');
}
