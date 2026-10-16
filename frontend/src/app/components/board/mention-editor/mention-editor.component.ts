import { firstValueFrom } from 'rxjs';
import { AfterViewInit, Component, DestroyRef, ElementRef, Injector, computed, effect, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { MentionRef } from '../../../core/models/board.models';
import { BoardMentionsService, CardPickTarget, TextPickField } from '../../../core/services/board-mentions.service';
import { BoardApiService } from '../../../core/services/board-api.service';
import { GlobalVariablesService } from '../../../core/services/global-variables.service';
import { fillerBreak, mentionChipNode, renderMentionText, serializeMentionText } from '../../../shared/utils/mention-dom';
import { mentionsIn, serializeMention } from '../../../shared/utils/mention-syntax';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';
import { ImageAnnotateComponent } from '../image-annotate/image-annotate.component';
import { DirChoice, blockDir, choiceLabel, nextChoice, textDir } from '../../../shared/utils/text-direction';
import { Block, CALLOUT_TITLES, CalloutTone, Inline, PillTone, TextColor, codeBlock, markdownBlocks } from '../../../shared/utils/markdown-blocks';
import { blocksToDom, blocksToHtml, domBlocks, hasFormatting, htmlBlocks, isHtml, textBlocks, variablePillNode } from '../../../shared/utils/rich-html';
import { CODE_LANGS, guessLang } from '../../../shared/utils/code-highlight';
import { BoardTemplate, DEFAULT_TEMPLATES, loadTemplates, saveTemplates } from '../../../shared/utils/board-templates';
import { VISUAL_TEMPLATES } from '../../../shared/utils/board-visuals';
import { VisualEditorComponent } from '../visuals/visual-editor.component';
import { AskClaudeService } from '../../../core/services/ask-claude.service';
import { SnippetsApiService } from '../../../core/services/snippets-api.service';
import { FILE_TYPES, FilePlace, WidgetInfo } from '../../../core/models/snippet.models';
import { fileLink, fileProblem } from '../visuals/board-files.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';

interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, li, blockquote, td, th, summary, pre, aside';
/** Visual blocks the block editor opens (specs/017 R37); their source is the <pre>'s text. */
const EDITABLE_VISUALS = new Set(['chart', 'stats', 'timeline', 'html', 'mermaid', 'python']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'IMG', 'DETAILS', 'ASIDE', 'DIV', 'SECTION']);

/**
 * A rich text box with mentions (FR-022, docs/board.md "Rich text"). Plain typing stays exactly what it always was: the
 * box holds text and mention pills and `value` is the text with `@[type:ref|label]` (shared/utils/mention-dom.ts). Using
 * the toolbar, the `/` menu, `{{` variables, the Markdown shortcuts (`## `, `- `, `[] `, `**x**`...), a pasted table or
 * picture makes it rich: `value` is then the board's HTML (shared/utils/rich-html.ts), cleaned again by the backend on
 * save. Enter submits and Shift+Enter is a new line (enterSends) - or, for long texts, Enter is a new line and Ctrl+Enter
 * submits. Each paragraph reads in its own direction as you type; ⇄ (Ctrl+Shift+X) forces one. A draft is kept per field.
 */
@Component({
  selector: 'app-mention-editor',
  standalone: true,
  imports: [MentionPickerComponent, ImageAnnotateComponent, VisualEditorComponent, MarkdownViewComponent],
  template: `
    <div class="board-editor" [class.split]="split()" [class.compact]="compact()">
      @if (draftNotice(); as d) {
        <div class="board-editor-draft">Unsaved draft from {{ d.at }} ·
          <button type="button" class="board-link" (click)="restoreDraft()">restore it</button> ·
          <button type="button" class="board-link" (click)="discardDraft()">discard</button></div>
      }
      @if (pickerOpen()) {
        <app-mention-picker [project]="project()" [cycleId]="cycleId()" [calls]="callMentions()"
                            [canPickAnywhere]="!!card() && !!pickField()" (pickAnywhere)="pickFromAnywhere()"
                            (picked)="picked($event)" (closed)="closePicker()" />
      }
      @if (toolbar() && (!compact() || fmtOpen())) {
        <div class="board-editor-tb" (mousedown)="keepSelection($event)">
          <select class="board-editor-style" title="Text style" (change)="styleBlock($any($event.target).value); $any($event.target).value = ''">
            <option value="">Style…</option><option value="p">Paragraph</option><option value="h2">Heading</option><option value="h3">Subheading</option>
            <option value="pre">Code block</option><option value="blockquote">Quote</option>
          </select>
          <button type="button" class="board-editor-btn" title="Bold (Ctrl+B)" (click)="exec('bold')"><b>B</b></button>
          <button type="button" class="board-editor-btn" title="Italic (Ctrl+I)" (click)="exec('italic')"><i>I</i></button>
          <button type="button" class="board-editor-btn" title="Underline (Ctrl+U)" (click)="exec('underline')"><u>U</u></button>
          <button type="button" class="board-editor-btn" title="Strikethrough" (click)="exec('strikeThrough')"><s>S</s></button>
          <button type="button" class="board-editor-btn" title="Inline code (Ctrl+E)" (click)="wrapInline('code')">&lt;/&gt;</button>
          <button type="button" class="board-editor-btn hl" title="Highlight (Ctrl+Shift+H)" (click)="wrapInline('mark')">▮</button>
          <span class="board-editor-dd">
            <button type="button" class="board-editor-btn" title="Text colour" (click)="toggleMenu('color', $event)">A▾</button>
            @if (menu() === 'color') {
              <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (c of colors; track c) {
                <button type="button" [class]="'board-editor-swatch board-md-c-' + c" (click)="color(c)">A {{ c }}</button> }
                <button type="button" class="board-editor-swatch" (click)="color(null)">no colour</button></span>
            }
          </span>
          <span class="board-editor-sep"></span>
          <button type="button" class="board-editor-btn" title="Bulleted list" (click)="list(false)">•</button>
          <button type="button" class="board-editor-btn" title="Numbered list" (click)="list(true)">1.</button>
          <button type="button" class="board-editor-btn" title="Checklist" (click)="checklist()">☑</button>
          <span class="board-editor-dd">
            <button type="button" class="board-editor-btn" title="Callout: note, warning, bug, fixed, next" (click)="toggleMenu('callout', $event)">▤▾</button>
            @if (menu() === 'callout') {
              <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (t of callouts; track t) {
                <button type="button" [class]="'board-editor-swatch callout-' + t" (click)="callout(t)">{{ calloutTitle(t) }}</button> }</span>
            }
          </span>
          <button type="button" class="board-editor-btn" title="Table" (click)="table()">▦</button>
          <span class="board-editor-dd">
            <button type="button" class="board-editor-btn" title="Visual: chart, stats, timeline, progress, tabs, diagram, HTML snippet - or type /" (click)="toggleMenu('visual', $event)">◇▾</button>
            @if (menu() === 'visual') {
              <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (v of visuals; track v.id) {
                <button type="button" class="board-editor-swatch" (click)="visual(v.id)">{{ v.label }}</button> }
                @if (widgets().length) {
                  <span class="board-editor-menu-sep">★ Widgets of the project</span>
                  @for (w of widgets(); track w.name) {
                    <button type="button" class="board-editor-swatch" [title]="w.kind.toLowerCase() + (w.author === 'CLAUDE' ? ' · by Claude' : '')" (click)="insertWidget(w.name)">★ {{ w.name }}</button>
                  }
                }</span>
            }
          </span>
          <button type="button" class="board-editor-btn" title="Collapsible section" (click)="fold()">▸</button>
          <span class="board-editor-dd">
            <button type="button" class="board-editor-btn" title="Status pill" (click)="toggleMenu('pill', $event)">✓▾</button>
            @if (menu() === 'pill') {
              <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (p of pills; track p.tone) {
                <button type="button" [class]="'board-md-pill ' + p.tone" (click)="pill(p.tone, p.text)">{{ p.text }}</button> }</span>
            }
          </span>
          <button type="button" class="board-editor-btn" title="Divider" (click)="insertBlocks([{ kind: 'rule' }])">―</button>
          <button type="button" class="board-editor-btn" title="Link (Ctrl+K)" (click)="link()">🔗</button>
          @if (images()) {
            <button type="button" class="board-editor-btn" title="Picture - or paste / drop a screenshot" (click)="file.click()">🖼</button>
            <input #file type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden (change)="pickFiles(file)" />
          }
          @if (attach()) {
            <button type="button" class="board-editor-btn" title="Attach a file (csv, json, log, har, pdf… at most 10 MB) - kept with the card" [disabled]="attaching()" (click)="attachInput.click()">📎</button>
            <input #attachInput type="file" multiple hidden [attr.accept]="fileAccept" (change)="attachFiles(attachInput)" />
          }
          <span class="board-editor-dd">
            <button type="button" class="board-editor-btn" title="Templates - or type /" (click)="toggleMenu('tpl', $event)">⧉▾</button>
            @if (menu() === 'tpl') {
              <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (t of templates(); track t.name) {
                <button type="button" class="board-editor-swatch" (click)="template(t)">{{ t.icon }} {{ t.name }}</button> }
                <button type="button" class="board-editor-swatch dim" (click)="editTemplates()">✎ Edit templates…</button></span>
            }
          </span>
          @if (canAsk()) {
            <span class="board-editor-dd">
              <button type="button" class="board-editor-btn" title="✦ Ask Claude about the selected text (or all of it)" (click)="toggleMenu('ask', $event)">✦▾</button>
              @if (menu() === 'ask') {
                <span class="board-editor-dd-menu" [class.up]="menuUp()">@for (a of askChoices; track a.label) {
                  <button type="button" class="board-editor-swatch" (click)="askClaude(a.instruction)">{{ a.label }}</button> }
                  <button type="button" class="board-editor-swatch" (click)="askCustom()">… Ask something else</button></span>
              }
            </span>
          }
          <span class="board-editor-grow"></span>
          <button type="button" class="board-editor-btn" [class.on]="split()" title="Split: the text beside how it will show (snippets run)" (click)="split.set(!split())">⇆</button>
          <button type="button" class="board-editor-btn" [class.on]="source()" title="See / edit what is stored" (click)="toggleSource()">&lt;&gt;</button>
        </div>
      }
      <div #box class="board-editor-box" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true" [hidden]="source()"
           [class.rich]="rich()"
           [attr.data-placeholder]="placeholder()" [attr.aria-label]="placeholder()" [style.min-height.em]="rows() * 1.5" [attr.dir]="boxDir()"
           (input)="onInput()" (keydown)="onKeydown($event)" (paste)="onPaste($event)" (blur)="saveCaret()" (click)="onBoxClick($event)"
           (dragover)="$event.preventDefault()" (drop)="onDrop($event)"></div>
      @if (source()) {
        <textarea class="board-editor-src" spellcheck="false" [value]="value()" [style.min-height.em]="rows() * 1.5 + 4"
                  (input)="fromSource($any($event.target).value)"></textarea>
      }
      @if (asked(); as a) {
        <div class="board-ask-panel" role="status">
          <div class="board-ask-head"><b>✦ Claude</b><span>{{ a.instruction }}</span><span class="board-editor-grow"></span>
            @if (!a.answer && !a.error) { <span class="board-dim">waiting for the chat…</span> }</div>
          @if (a.error) { <div class="board-error">{{ a.error }}</div> }
          @if (a.answer) { <div class="board-ask-answer"><app-markdown-view [text]="a.answer" [previews]="false" /></div> }
          <div class="board-ask-foot">
            @if (a.answer) {
              <button type="button" class="action-btn primary" (click)="acceptAsk('replace')">{{ a.hadSelection ? 'Replace the selection' : 'Replace the text' }}</button>
              <button type="button" class="action-btn" (click)="acceptAsk('below')">Insert below</button>
            }
            <button type="button" class="action-btn" (click)="discardAsk()">{{ a.answer || a.error ? 'Discard' : 'Stop' }}</button>
          </div>
        </div>
      }
      @if (split()) {
        <div class="board-editor-preview" aria-label="Preview"><app-markdown-view [text]="previewText()" empty="Nothing to show yet." [idPrefix]="'pv-'" /></div>
      }
      @if (popup(); as p) {
        <div class="board-editor-menu" [style.top.px]="p.top" [style.bottom.px]="p.bottom" [style.left.px]="p.left" (mousedown)="$event.preventDefault()">
          @for (item of popupItems(); track item.id; let i = $index) {
            <button type="button" class="board-editor-menu-item" [class.on]="i === popupIndex()" (click)="item.run()">{{ item.label }}
              @if (item.hint) { <small>{{ item.hint }}</small> }</button>
          } @empty {
            <span class="board-editor-menu-empty">{{ p.kind === 'var' ? 'No global variable matches - ' + p.query + ' is inserted as typed' : 'Nothing matches' }}</span>
          }
        </div>
      }
      @if (visualEdit(); as ve) {
        <app-visual-editor [lang]="ve.lang" [source]="ve.source" [info]="ve.info" [saveLabel]="ve.pre ? 'Save' : 'Insert'"
                           (saved)="visualSaved($event)" (closed)="visualEdit.set(null)" />
      }
      @if (visualBar(); as vb) {
        <div class="board-editor-imgbar" [style.top.px]="vb.top" [style.left.px]="vb.left" (mousedown)="$event.preventDefault()">
          <button type="button" class="board-link" (click)="editVisual()">✎ Edit {{ vb.lang }}</button></div>
      }
      @if (imageBar(); as ib) {
        <div class="board-editor-imgbar" [style.top.px]="ib.top" [style.left.px]="ib.left" (mousedown)="$event.preventDefault()">
          <button type="button" class="board-link" (click)="annotate()">✎ Mark</button> ·
          <button type="button" class="board-link" (click)="removeImage()">✕ Remove</button>
        </div>
      }
      @if (annotating(); as src) {
        <app-image-annotate [src]="src" (saved)="annotated($event)" (closed)="annotating.set(null)" />
      }
      @if (editingTemplates()) {
        <div class="run-dialog-bg" (click)="editingTemplates.set(false)">
          <div class="run-dialog" role="dialog" aria-label="Templates" (click)="$event.stopPropagation()">
            <div class="run-dialog-head">Templates <span class="run-dim">- Markdown; kept in this browser</span></div>
            @for (t of templateDraft(); track $index; let i = $index) {
              <label class="run-dim">
                <input #tn class="run-input" [value]="t.name" (input)="editTemplate(i, tn.value, null)" />
                <textarea #tt class="run-text" rows="5" [value]="t.text" (input)="editTemplate(i, null, tt.value)"></textarea>
              </label>
            }
            <div class="run-dialog-row run-dialog-acts">
              <button type="button" class="board-copy" (click)="resetTemplates()">Reset to the defaults</button>
              <button type="button" class="board-copy" (click)="addTemplate()">+ Template</button>
              <button type="button" class="board-copy" (click)="editingTemplates.set(false)">Cancel</button>
              <button type="button" class="board-copy run-primary" (click)="saveTemplateDraft()">Save</button>
            </div>
          </div>
        </div>
      }
      @if (uploadError(); as e) { <div class="run-msg run-msg-err">{{ e }}</div> }
      @if (compact()) {
        <div class="board-editor-cbar">
          <button type="button" class="board-editor-cbtn" title="Mention something (@)" (mousedown)="$event.preventDefault()" (click)="openPicker()">&#64;</button>
          @if (commands().length || toolbar()) {
            <button type="button" class="board-editor-cbtn" title="Skills and blocks (/)" (mousedown)="$event.preventDefault()" (click)="typeSlash()">/</button>
          }
          @if (toolbar()) {
            <button type="button" class="board-editor-cbtn" [class.on]="fmtOpen()" title="Formatting" (mousedown)="$event.preventDefault()" (click)="fmtOpen.set(!fmtOpen())">Aa</button>
          }
          <button type="button" class="board-editor-cbtn" [class.on]="dirChoice() !== 'auto'" (mousedown)="$event.preventDefault()" (click)="flipDir()"
                  title="Text direction: auto, right-to-left or left-to-right · Ctrl+Shift+X">{{ dirLabel(dirChoice()) }}</button>
          <ng-content select="[editorTools]" />
          @if (draftKey() && value().trim()) { <span class="board-editor-saved" title="Kept in this browser until you send it">✓ draft saved</span> }
          <span class="board-editor-grow"></span>
          @if (cancellable()) { <button type="button" class="board-editor-cbtn" (click)="cancelled.emit()">Cancel</button> }
          <button type="button" class="board-editor-send" [disabled]="!value().trim() && !allowEmpty()"
                  [title]="submitLabel() + (enterSends() ? ' (Enter · Shift+Enter new line)' : ' (Ctrl+Enter)')" (click)="submit()">↑</button>
        </div>
      } @else {
        <div class="board-editor-hint">
          <span><kbd>&#64;</kbd> mention · <kbd>/</kbd> blocks · <kbd>{{ '{{' }}</kbd> variable · @if (enterSends()) {<kbd>Enter</kbd> {{ submitLabel().toLowerCase() }} · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line} @else {<kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ submitLabel().toLowerCase() }}}</span>
          <span class="board-editor-actions">
            <button type="button" class="action-btn board-editor-dir" [class.on]="dirChoice() !== 'auto'" (mousedown)="$event.preventDefault()" (click)="flipDir()"
                    title="Text direction: auto (each paragraph from what you type), right-to-left or left-to-right · Ctrl+Shift+X">{{ dirLabel(dirChoice()) }}</button>
            <button type="button" class="action-btn" title="Mention something" (mousedown)="$event.preventDefault()" (click)="openPicker()">&#64; Mention</button>
            @if (cancellable()) { <button type="button" class="action-btn" (click)="cancelled.emit()">Cancel</button> }
            <button type="button" class="action-btn primary" [disabled]="!value().trim() && !allowEmpty()" (click)="submit()">{{ submitLabel() }}</button>
          </span>
        </div>
      }
    </div>`,
})
export class MentionEditorComponent implements AfterViewInit {
  readonly value = model('');
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  /** Call mentions from around the editor (the card's links) - offered with the text's own for statements and lines. */
  readonly contextMentions = input<readonly MentionRef[]>([]);
  /** The card being written on, when there is one - with `pickField`, offers "Pick from anywhere". */
  readonly card = input<CardPickTarget | null>(null);
  /** Which of the card's texts this is, so calls picked elsewhere come back into it (the comment or the description). */
  readonly pickField = input<TextPickField | null>(null);
  readonly placeholder = input('Write… type @ to mention, / for blocks, {{ for a variable');
  readonly submitLabel = input('Comment');
  readonly cancellable = input(false);
  readonly allowEmpty = input(false);
  readonly rows = input(3);
  /** Enter sends (a comment, reply, answer); false for long texts, where Enter is a line break and Ctrl+Enter sends. */
  readonly enterSends = input(true);
  /** The formatting toolbar (rich text); off keeps a bare box. */
  readonly toolbar = input(true);
  /** One box like a chat's: the tools and Send in a row inside it, the formatting toolbar behind "Aa". */
  readonly compact = input(false);
  readonly fmtOpen = signal(false);
  /** Pictures may be pasted, dropped or picked. */
  readonly images = input(true);
  /** Where 📎 attaches files (specs/017 R36): the card or cycle the text belongs to; null hides 📎. */
  readonly attach = input<FilePlace | null>(null);
  readonly attaching = signal(false);
  readonly fileAccept = FILE_TYPES.map((t) => '.' + t).join(',');
  /** Where this field's unsent draft is kept (this browser) - e.g. "comment:<card id>"; null keeps none. */
  readonly draftKey = input<string | null>(null);
  /** Commands listed first in the "/" menu - picking one writes `/name ` (the board chat's skills). */
  readonly commands = input<readonly { readonly name: string; readonly what: string }[]>([]);
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  private readonly mentions = inject(BoardMentionsService);
  private readonly injector = inject(Injector);
  readonly pickerOpen = signal(false);
  readonly source = signal(false);
  /** ⇆ (specs/017 R39): the text beside how it will show. The preview follows the text once typing settles. */
  readonly split = signal(false);
  readonly previewText = signal('');
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  readonly rich = signal(false);
  readonly menu = signal<'color' | 'callout' | 'pill' | 'tpl' | 'visual' | 'ask' | null>(null);
  readonly popup = signal<{ kind: 'slash' | 'var'; query: string; top: number | null; bottom: number | null; left: number } | null>(null);
  readonly popupIndex = signal(0);
  readonly imageBar = signal<{ top: number; left: number } | null>(null);
  /** The block editor: a new visual (pre null) or the one clicked in the box. */
  readonly visualEdit = signal<{ lang: string; source: string; info: string; pre: HTMLElement | null } | null>(null);
  readonly visualBar = signal<{ top: number; left: number; lang: string; pre: HTMLElement } | null>(null);
  readonly visuals: readonly { id: string; label: string }[] = [
    { id: 'chart', label: '▤ Chart' }, { id: 'stats', label: '▦ Stats' }, { id: 'timeline', label: '⏱ Timeline' },
    { id: 'progress', label: '▬ Progress' }, { id: 'tabs', label: '⧉ Tabs' },
    { id: 'mermaid', label: '⬡ Diagram' }, { id: 'html', label: '◈ HTML snippet' }, { id: 'python', label: '🐍 Python' },
  ];
  readonly annotating = signal<string | null>(null);
  readonly uploadError = signal<string | null>(null);
  readonly draftNotice = signal<{ text: string; at: string } | null>(null);
  readonly templates = signal<readonly BoardTemplate[]>(loadTemplates());
  readonly editingTemplates = signal(false);
  readonly templateDraft = signal<BoardTemplate[]>([]);
  /** ⇄: auto - each paragraph follows what is typed (Arabic right-to-left, English left-to-right) - or one forced. */
  readonly dirChoice = signal<DirChoice>('auto');
  readonly dir = computed(() => blockDir(this.dirChoice(), this.value().replace(/@\[[^\]]*\]/g, ' ')));
  /** Plain text reads as one block; rich text's paragraphs each pick their own (set on them as you type). */
  readonly boxDir = computed(() => (this.rich() ? (this.dirChoice() === 'auto' ? null : this.dirChoice()) : this.dir()));
  readonly dirLabel = choiceLabel;
  readonly colors: readonly TextColor[] = ['red', 'green', 'amber', 'blue', 'purple'];
  readonly callouts: readonly CalloutTone[] = ['info', 'warn', 'bug', 'ok', 'next'];
  readonly pills: readonly { tone: PillTone; text: string }[] = [{ tone: 'ok', text: '✓ ok' }, { tone: 'fail', text: '✕ fail' },
    { tone: 'wait', text: '⏳ waiting' }, { tone: 'info', text: 'ℹ info' }];
  private readonly box = viewChild.required<ElementRef<HTMLDivElement>>('box');

  /** Puts the caret in the box, after any draft it holds (the card's "/" key, Reply…). */
  focus(): void {
    const box = this.box().nativeElement;
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  /** The text this box last showed or produced - a value that differs came from outside and is rendered again. */
  private shown: string | null = null;
  private ready = false;
  /** Where a pick goes: the `@` that opened the picker (replaced by the pick), or the caret when the box was left. */
  private at: Range | null = null;
  private replacesAt = false;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private selectedImage: HTMLImageElement | null = null;
  /** The range a `/` or `{{` menu replaces when it picks. */
  private popupRange: Range | null = null;

  readonly callMentions = computed(() => {
    const seen = new Set<string>();
    return [...mentionsIn(this.value()), ...this.contextMentions()].filter((m) => {
      if (m.type.toLowerCase() !== 'call' || seen.has(m.ref)) return false;
      seen.add(m.ref);
      return true;
    });
  });

  readonly popupItems = computed<MenuItem[]>(() => {
    const p = this.popup();
    if (!p) return [];
    const q = p.query.toLowerCase();
    if (p.kind === 'var') {
      const vars = this.variables();
      const names = Object.keys(vars?.state().variables ?? {}).sort();
      return names.filter((n) => n.toLowerCase().includes(q)).slice(0, 12).map((n) => ({
        id: n, label: `{{${n}}}`, hint: vars?.isSecret(n) ? 'secret' : clip(vars?.state().variables[n] ?? ''), run: () => this.pickVariable(n),
      }));
    }
    const all: MenuItem[] = [
      // Commands the host offers first (the board chat's /alfred-* skills, specs/022 FR-022): typed as text, read on send.
      ...this.commands().map((c) => ({ id: `cmd-${c.name}`, label: `/${c.name}`, hint: c.what, run: () => this.slash(() => this.insertText(`/${c.name} `)) })),
      { id: 'h2', label: 'Heading', hint: '##', run: () => this.slash(() => this.styleBlock('h2')) },
      { id: 'h3', label: 'Subheading', hint: '###', run: () => this.slash(() => this.styleBlock('h3')) },
      { id: 'ul', label: '• Bulleted list', hint: '-', run: () => this.slash(() => this.list(false)) },
      { id: 'ol', label: '1. Numbered list', hint: '1.', run: () => this.slash(() => this.list(true)) },
      { id: 'check', label: '☑ Checklist', hint: '[]', run: () => this.slash(() => this.checklist()) },
      ...this.callouts.map((t) => ({ id: `callout-${t}`, label: `▤ ${this.calloutTitle(t)}`, hint: 'callout', run: () => this.slash(() => this.callout(t)) })),
      { id: 'table', label: '▦ Table', run: () => this.slash(() => this.table()) },
      ...this.visuals.map((v) => ({ id: `visual-${v.id}`, label: v.label, hint: 'visual', run: () => this.slash(() => this.visual(v.id)) })),
      { id: 'fold', label: '▸ Collapsible', run: () => this.slash(() => this.fold()) },
      { id: 'quote', label: '❝ Quote', hint: '>', run: () => this.slash(() => this.styleBlock('blockquote')) },
      ...CODE_LANGS.map((l) => ({ id: `code-${l.id}`, label: `</> Code: ${l.label}`, hint: '```', run: () => this.slash(() => this.codeBlockOf(l.id)) })),
      { id: 'hr', label: '― Divider', hint: '---', run: () => this.slash(() => this.insertBlocks([{ kind: 'rule' }])) },
      ...this.pills.map((x) => ({ id: `pill-${x.tone}`, label: `${x.text} pill`, run: () => this.slash(() => this.pill(x.tone, x.text)) })),
      ...(this.images() ? [{ id: 'image', label: '🖼 Picture', run: () => this.slash(() => this.pickImage()) }] : []),
      { id: 'mention', label: '@ Mention', run: () => this.slash(() => this.openPicker()) },
      ...this.dataCommands.map((d) => ({ id: d.id, label: d.label, hint: 'data', run: () => this.slash(() => this.dataCommand(d.id)) })),
      { id: 'var', label: '{{ }} Variable', run: () => this.slash(() => this.openVariables()) },
      ...this.templates().map((t) => ({ id: `tpl-${t.name}`, label: `${t.icon} ${t.name}`, hint: 'template', run: () => this.slash(() => this.template(t)) })),
    ];
    return all.filter((i) => !q || i.label.toLowerCase().includes(q) || i.id.includes(q)).slice(0, 14);
  });

  constructor() {
    effect(() => {
      const text = this.value();
      untracked(() => {
        if (this.ready && text !== this.shown) this.render(text);
      });
    });
    effect(() => {
      const text = this.value();
      if (!this.split()) return;
      untracked(() => {
        if (this.previewTimer) clearTimeout(this.previewTimer);
        if (!this.previewText()) { this.previewText.set(text); return; }
        this.previewTimer = setTimeout(() => this.previewText.set(this.value()), 500);
      });
    }, { allowSignalWrites: true });
    inject(DestroyRef).onDestroy(() => {
      if (this.draftTimer) clearTimeout(this.draftTimer);
      if (this.previewTimer) clearTimeout(this.previewTimer);
    });
  }

  ngAfterViewInit(): void {
    this.ready = true;
    this.render(this.value());
    const draft = this.readDraft();
    if (draft && draft.text.trim() && draft.text !== this.value()) {
      this.draftNotice.set({ text: draft.text, at: new Date(draft.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    }
  }

  // ------------------------------------------------------------------------------------------------------------ typing

  onInput(): void {
    this.sync();
    this.imageBar.set(null);
    const sel = this.selection();
    if (!sel || !sel.isCollapsed || sel.anchorNode?.nodeType !== Node.TEXT_NODE) {
      this.popup.set(null);
      return;
    }
    const node = sel.anchorNode as Text;
    const offset = sel.anchorOffset;
    const before = node.data.slice(0, offset);
    const prev = before.length >= 2 ? before[before.length - 2] : node.previousSibling ? ' ' : '';
    if (before.endsWith('@') && (prev === '' || /\s/.test(prev))) {
      const range = document.createRange();
      range.setStart(node, offset - 1);
      range.setEnd(node, offset);
      this.at = range;
      this.replacesAt = true;
      this.pickerOpen.set(true);
      return;
    }
    if (this.markdownShortcut(node, offset)) return;
    this.updatePopup(node, offset);
  }

  /** `## `, `- `, `1. `, `[] `, `> `, ``` and `---` at the start of a line, `**x**`, `==x==`, `~~x~~` and `` `x` `` as you type. */
  private markdownShortcut(node: Text, offset: number): boolean {
    if (!this.toolbar()) return false;
    const before = node.data.slice(0, offset);
    const lineStart = Math.max(before.lastIndexOf('\n') + 1, 0);
    const line = before.slice(lineStart);
    const atBlockStart = !node.previousSibling || lineStart > 0 || (node.parentElement !== this.box().nativeElement && !node.previousSibling);
    const block: [RegExp, () => void][] = [
      [/^(#{1,3}) $/, () => this.styleBlock(line.length === 2 ? 'h2' : line.length === 3 ? 'h2' : 'h3')],
      [/^[-*] $/, () => this.list(false)],
      [/^1[.)] $/, () => this.list(true)],
      [/^\[\s?\] $/, () => this.checklist()],
      [/^> $/, () => this.styleBlock('blockquote')],
      [/^```$/, () => this.codeBlockOf('')],
      [/^--- $/, () => this.insertBlocks([{ kind: 'rule' }])],
    ];
    if (atBlockStart) {
      for (const [re, run] of block) {
        if (!re.test(line)) continue;
        const range = document.createRange();
        range.setStart(node, lineStart);
        range.setEnd(node, offset);
        range.deleteContents();
        this.placeCaret(node, lineStart);
        run();
        return true;
      }
    }
    const inline: [RegExp, 'b' | 'mark' | 's' | 'code'][] = [[/\*\*([^*\n]+)\*\*$/, 'b'], [/==([^=\n]+)==$/, 'mark'], [/~~([^~\n]+)~~$/, 's'],
      [/`([^`\n]+)`$/, 'code']];
    for (const [re, tag] of inline) {
      const m = re.exec(before);
      if (!m) continue;
      const range = document.createRange();
      range.setStart(node, offset - m[0].length);
      range.setEnd(node, offset);
      range.deleteContents();
      const el = document.createElement(tag);
      el.textContent = m[1];
      range.insertNode(el);
      const space = document.createTextNode('​');
      el.after(space);
      this.placeCaretAfter(space);
      this.sync();
      return true;
    }
    return false;
  }

  /** The `/` block menu and the `{{` variable menu follow what is typed after them. */
  private updatePopup(node: Text, offset: number): void {
    const before = node.data.slice(0, offset);
    const slashAt = before.lastIndexOf('/');
    const varAt = before.lastIndexOf('{{');
    const p = this.popup();
    if (varAt >= 0 && !before.slice(varAt).includes('}') && /^\{\{[\w.-]*$/.test(before.slice(varAt)) && this.toolbar()) {
      this.openPopup('var', node, varAt, offset, before.slice(varAt + 2));
      return;
    }
    if (slashAt >= 0 && this.toolbar() && /^\/[\w ]{0,20}$/.test(before.slice(slashAt)) && (slashAt === 0 || /\s/.test(before[slashAt - 1]))
      && (p || before.slice(slashAt) === '/')) {
      this.openPopup('slash', node, slashAt, offset, before.slice(slashAt + 1));
      return;
    }
    this.popup.set(null);
  }

  private openPopup(kind: 'slash' | 'var', node: Text, from: number, to: number, query: string): void {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    this.popupRange = range;
    const r = range.getBoundingClientRect();
    const host = this.box().nativeElement.parentElement!.getBoundingClientRect();
    if (kind === 'var') this.variables()?.load();
    this.popupIndex.set(0);
    // below the line, or above it when the box sits low on the page (the comment box at the bottom of the drawer)
    const up = window.innerHeight - r.bottom < 300 && r.top > 300;
    this.popup.set({ kind, query, top: up ? null : r.bottom - host.top + 4, bottom: up ? host.bottom - r.top + 4 : null,
      left: Math.max(0, Math.min(r.left - host.left, host.width - 260)) });
  }

  onKeydown(event: KeyboardEvent): void {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'x') {
      event.preventDefault();
      this.flipDir();
      return;
    }
    if (this.popup()) {
      const items = this.popupItems();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const n = Math.max(1, items.length);
        this.popupIndex.update((i) => (i + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); this.popup.set(null); return; }
      if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
        event.preventDefault();
        items[Math.min(this.popupIndex(), items.length - 1)].run();
        return;
      }
      if (event.key === 'Enter' && this.popup()!.kind === 'var') {
        event.preventDefault();
        this.pickVariable(this.popup()!.query);
        return;
      }
    }
    if (ctrl && !event.shiftKey && this.toolbar()) {
      const k = event.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'u') { event.preventDefault(); this.exec(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline'); return; }
      if (k === 'k') { event.preventDefault(); this.link(); return; }
      if (k === 'e') { event.preventDefault(); this.wrapInline('code'); return; }
    }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'h' && this.toolbar()) { event.preventDefault(); this.wrapInline('mark'); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    const sends = ctrl || (this.enterSends() && !event.shiftKey && !event.altKey);
    if (sends && this.pickerOpen()) {
      event.preventDefault(); // Enter belongs to the mention picker while it is open - never a half-written send
    } else if (sends) {
      event.preventDefault();
      this.submit();
    } else if (this.rich()) {
      // a new paragraph (a new item in a list, out of a heading); in a code block a new line
      event.preventDefault();
      if (this.closestIn(this.selection()?.anchorNode ?? null, 'pre')) document.execCommand('insertText', false, '\n');
      else document.execCommand('insertParagraph');
      this.sync();
    } else {
      // A line break as "\n" in the text, not the <div> a browser would add.
      event.preventDefault();
      this.insertText('\n');
    }
  }

  // ------------------------------------------------------------------------------------------------------------ paste

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const data = event.clipboardData;
    if (!data) return;
    const files = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length && this.images()) {
      files.forEach((f) => this.upload(f));
      return;
    }
    const html = data.getData('text/html');
    const text = data.getData('text/plain') ?? '';
    if (html && this.toolbar()) {
      const blocks = htmlBlocks(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, ''));
      if (blocks.some((b) => b.kind !== 'paragraph' || b.inlines.some((i) => i.kind !== 'text' && i.kind !== 'br' && i.kind !== 'mention'))) {
        this.insertBlocks(blocks);
        return;
      }
    }
    if (!text) return;
    const lang = this.toolbar() ? guessLang(text) : null;
    if (lang) {
      this.insertBlocks([codeBlock(text.replace(/\s+$/, ''), lang)]);
      return;
    }
    if (this.toolbar() && /^https?:\/\/\S+$/.test(text.trim()) && this.rich()) {
      document.execCommand('insertHTML', false, `<a href="${escAttr(text.trim())}">${escHtml(text.trim())}</a>&nbsp;`);
      this.sync();
      return;
    }
    if (this.toolbar() && this.rich() && hasFormatting(text)) {
      this.insertBlocks(markdownBlocks(text));
      return;
    }
    this.insertText(text);
    if (mentionsIn(text).length) {
      this.render(this.value());
      this.caretToEnd();
    }
  }

  onDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length || !this.images()) return;
    event.preventDefault();
    const pos = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
    if (pos) { const sel = this.selection(); sel?.removeAllRanges(); sel?.addRange(pos); }
    files.forEach((f) => this.upload(f));
  }

  /** Attaches the picked files to the card or cycle and puts a link to each at the caret. */
  async attachFiles(input: HTMLInputElement): Promise<void> {
    const place = this.attach();
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!place || !files.length) return;
    const caret = this.caretNow();
    this.uploadError.set(null);
    this.attaching.set(true);
    const api = this.injector.get(SnippetsApiService);
    const links: string[] = [];
    try {
      for (const f of files) {
        const problem = fileProblem(f);
        if (problem) { this.uploadError.set(problem); continue; }
        try {
          links.push(fileLink(await firstValueFrom(api.attach(place, f))));
        } catch (e) {
          this.uploadError.set((e as { error?: { message?: string } })?.error?.message ?? `${f.name} could not be attached`);
        }
      }
    } finally {
      this.attaching.set(false);
    }
    if (!links.length) return;
    this.at = caret;
    if (this.rich()) {
      this.insertInline(links.map((l) => {
        const m = /^\[(.*)\]\((.*)\)$/.exec(l)!;
        return `<a href="${escAttr(m[2])}">${escHtml(m[1])}</a>`;
      }).join(' ') + '&nbsp;');
    } else {
      this.focusBox();
      this.insertText(links.join(' ') + ' ');
    }
  }

  private caretNow(): Range | null {
    const box = this.box().nativeElement;
    const sel = this.selection();
    return sel && sel.rangeCount && box.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : this.at;
  }

  pickFiles(input: HTMLInputElement): void {
    Array.from(input.files ?? []).forEach((f) => this.upload(f));
    input.value = '';
  }

  pickImage(): void {
    (this.box().nativeElement.parentElement?.querySelector('input[type=file]') as HTMLInputElement | null)?.click();
  }

  private upload(file: Blob, replace: HTMLImageElement | null = null): void {
    this.uploadError.set(null);
    if (file.size > 5 * 1024 * 1024) { this.uploadError.set('A picture can be at most 5 MB'); return; }
    this.injector.get(BoardApiService).uploadImage(file).subscribe({
      next: (r) => {
        if (replace && this.box().nativeElement.contains(replace)) {
          replace.setAttribute('src', r.url);
          this.sync();
        } else {
          this.insertBlocks([{ kind: 'image', src: r.url, alt: (file as File).name ?? 'picture' }]);
        }
      },
      error: (e) => this.uploadError.set(e?.error?.message ?? 'The picture could not be saved'),
    });
  }

  onBoxClick(event: MouseEvent): void {
    this.menu.set(null);
    this.popup.set(null);
    const pre = event.target instanceof Element ? event.target.closest('pre[data-lang]') as HTMLElement | null : null;
    const lang = pre?.dataset['lang'] ?? '';
    if (pre && EDITABLE_VISUALS.has(lang) && this.box().nativeElement.contains(pre)) {
      const r = pre.getBoundingClientRect();
      const host = this.box().nativeElement.parentElement!.getBoundingClientRect();
      this.visualBar.set({ top: r.top - host.top + 4, left: r.right - host.left - 120, lang, pre });
    } else {
      this.visualBar.set(null);
    }
    const img = event.target instanceof HTMLImageElement ? event.target : null;
    this.selectedImage = img;
    if (!img) { this.imageBar.set(null); return; }
    const r = img.getBoundingClientRect();
    const host = this.box().nativeElement.parentElement!.getBoundingClientRect();
    this.imageBar.set({ top: r.top - host.top + 4, left: r.left - host.left + 4 });
  }

  /** The ◇ menu: chart, stats and timeline open the block editor; progress and tabs go in as a template to edit in place. */
  visual(id: string): void {
    this.menu.set(null);
    if (EDITABLE_VISUALS.has(id)) {
      this.saveCaret();
      this.visualEdit.set({ lang: id, source: VISUAL_TEMPLATES[id] ?? '', info: id === 'html' || id === 'python' ? 'live' : '', pre: null });
      return;
    }
    this.insertBlocks(markdownBlocks(VISUAL_TEMPLATES[id] ?? ''));
  }

  editVisual(): void {
    const vb = this.visualBar();
    if (!vb) return;
    this.visualBar.set(null);
    this.visualEdit.set({ lang: vb.lang, source: vb.pre.textContent ?? '', info: vb.pre.dataset['info'] ?? '', pre: vb.pre });
  }

  visualSaved(out: { text: string; info: string }): void {
    const ve = this.visualEdit();
    this.visualEdit.set(null);
    if (!ve) return;
    if (ve.pre && this.box().nativeElement.contains(ve.pre)) {
      ve.pre.textContent = out.text;
      if (out.info) ve.pre.dataset['info'] = out.info;
      else delete ve.pre.dataset['info'];
      this.sync();
      return;
    }
    this.insertBlocks([{ kind: 'visual', lang: ve.lang as 'chart', info: out.info, text: out.text }]);
  }

  annotate(): void {
    if (this.selectedImage) this.annotating.set(this.selectedImage.src);
    this.imageBar.set(null);
  }

  annotated(blob: Blob): void {
    this.annotating.set(null);
    this.upload(blob, this.selectedImage);
  }

  removeImage(): void {
    this.selectedImage?.remove();
    this.selectedImage = null;
    this.imageBar.set(null);
    this.sync();
  }

  // ---------------------------------------------------------------------------------------------------------- toolbar

  /** The toolbar never takes the focus from the box - the selection stays where the user was. */
  keepSelection(event: MouseEvent): void {
    const t = event.target as HTMLElement;
    if (t.tagName !== 'SELECT' && t.tagName !== 'OPTION' && t.tagName !== 'INPUT') event.preventDefault();
  }

  /** A menu opens upward when the box sits near the bottom of the window (the comment box) and there is more room above. */
  readonly menuUp = signal(false);

  toggleMenu(m: 'color' | 'callout' | 'pill' | 'tpl' | 'visual' | 'ask', event?: Event): void {
    const r = (event?.currentTarget as Element | null)?.getBoundingClientRect();
    if (r) this.menuUp.set(window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
    this.menu.update((x) => (x === m ? null : m));
    if (this.menu() === 'visual') void this.loadWidgets();
  }

  /** The project's widgets (specs/017 R34), read when the Visual menu opens. */
  readonly widgets = signal<readonly WidgetInfo[]>([]);

  private async loadWidgets(): Promise<void> {
    const project = this.project() || this.card()?.project || '';
    try {
      this.widgets.set(await firstValueFrom(this.injector.get(SnippetsApiService).widgets(project)));
    } catch {
      this.widgets.set([]);
    }
  }

  /** `{{widget:name}}` on a line of its own - the editor's preview and the board draw it. */
  insertWidget(name: string): void {
    this.menu.set(null);
    this.focusBox();
    if (this.rich()) this.insertBlocks([{ kind: 'widget', name, args: '', params: {} }]);
    else this.insertText(`\n{{widget:${name}}}\n`);
  }

  exec(command: string, arg?: string): void {
    this.focusBox();
    document.execCommand(command, false, arg);
    this.menu.set(null);
    this.sync();
  }

  styleBlock(tag: string): void {
    if (!tag) return;
    this.ensureRich();
    this.focusBox();
    if (tag === 'pre') {
      this.codeBlockOf('');
      return;
    }
    document.execCommand('formatBlock', false, tag);
    this.sync();
  }

  list(ordered: boolean): void {
    this.ensureRich();
    this.focusBox();
    document.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList');
    this.sync();
  }

  checklist(): void {
    this.ensureRich();
    this.focusBox();
    document.execCommand('insertUnorderedList');
    const ul = this.closestIn(this.selection()?.anchorNode ?? null, 'ul') as HTMLElement | null;
    if (ul) {
      ul.setAttribute('data-checklist', '');
      ul.querySelectorAll(':scope > li').forEach((li) => { if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false'); });
    }
    this.sync();
  }

  callout(tone: CalloutTone): void {
    this.insertBlocks([{ kind: 'callout', tone, title: [{ kind: 'text', text: CALLOUT_TITLES[tone] }], blocks: [] }]);
  }

  table(): void {
    const cell = (t: string): Inline[] => (t ? [{ kind: 'text', text: t }] : []);
    this.insertBlocks([{ kind: 'table', header: [cell('Call'), cell('Before'), cell('After')], rows: [[cell(''), cell(''), cell('')]] }]);
  }

  fold(): void {
    this.insertBlocks([{ kind: 'fold', summary: [{ kind: 'text', text: 'Details' }], blocks: [] }]);
  }

  codeBlockOf(lang: string): void {
    const sel = this.selection();
    const text = sel && !sel.isCollapsed && this.box().nativeElement.contains(sel.anchorNode) ? sel.toString() : '';
    if (text) document.execCommand('delete');
    this.insertBlocks([codeBlock(text || (lang === 'diff' ? '- before\n+ after' : ''), lang)]);
  }

  pill(tone: PillTone, label: string): void {
    this.menu.set(null);
    const text = label.replace(/^[^\w]+\s*/, '');
    this.insertInline(`<span data-pill="${tone}">${escHtml(text)}</span>&nbsp;`);
  }

  color(c: TextColor | null): void {
    this.menu.set(null);
    if (!c) { this.exec('removeFormat'); return; }
    this.wrapInline('span', { 'data-color': c });
  }

  link(): void {
    const sel = this.selection();
    const has = !!sel && !sel.isCollapsed;
    const url = window.prompt('Link (https://…)', 'https://');
    if (!url || !/^(https?:\/\/|mailto:)/i.test(url)) return;
    if (has) this.exec('createLink', url);
    else this.insertInline(`<a href="${escAttr(url)}">${escHtml(url)}</a>&nbsp;`);
  }

  template(t: BoardTemplate): void {
    this.menu.set(null);
    this.insertBlocks(markdownBlocks(t.text));
  }

  /** Wraps the selection in an inline tag (highlight, code, colour). */
  wrapInline(tag: string, attrs: Record<string, string> = {}): void {
    this.focusBox();
    const sel = this.selection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.box().nativeElement.contains(range.commonAncestorContainer)) return;
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.appendChild(range.extractContents());
    range.insertNode(el);
    this.placeCaretAfter(el);
    this.menu.set(null);
    this.sync();
  }

  /** Blocks at the caret - a callout, a table, a template, a pasted page... (the editor turns rich). */
  insertBlocks(blocks: readonly Block[]): void {
    if (!blocks.length) return;
    this.ensureRich();
    this.focusBox();
    const html = blocksToDom(blocks, document).map((n) => (n instanceof Element ? n.outerHTML : escHtml(n.textContent ?? ''))).join('');
    // a paragraph after, so the caret has somewhere to go below a callout or a table
    document.execCommand('insertHTML', false, html + '<p><br></p>');
    this.menu.set(null);
    this.sync();
  }

  private insertInline(html: string): void {
    this.focusBox();
    document.execCommand('insertHTML', false, html);
    this.sync();
  }

  /** Text not yet in blocks turned into paragraphs, one per line, mentions and formatting kept - before a block format. */
  private ensureRich(): void {
    const box = this.box().nativeElement;
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (Array.from(box.children).some((c) => BLOCK_TAGS.has(c.tagName))) return;
    const before = this.caretTextOffset();
    const blocks = splitAtBreaks(domBlocks(box));
    box.replaceChildren(...blocksToDom(blocks.length ? blocks : [{ kind: 'paragraph', inlines: [] }], document));
    this.rich.set(true);
    this.setCaretTextOffset(before);
  }

  toggleSource(): void {
    this.source.update((s) => !s);
    if (!this.source()) this.render(this.value());
  }

  fromSource(text: string): void {
    this.shown = null;
    this.value.set(text);
    this.saveDraft(text);
  }

  // -------------------------------------------------------------------------------------------------------- variables

  private variables(): GlobalVariablesService | null {
    try { return this.injector.get(GlobalVariablesService); } catch { return null; }
  }

  openVariables(): void {
    this.focusBox();
    document.execCommand('insertText', false, '{{');
    this.onInput();
  }

  pickVariable(name: string): void {
    const clean = name.trim().replace(/[^\w.-]/g, '');
    if (!clean) { this.popup.set(null); return; }
    const range = this.popupRange;
    this.popup.set(null);
    if (range && this.box().nativeElement.contains(range.startContainer)) range.deleteContents();
    const pill = variablePillNode(document, clean);
    const space = document.createTextNode(' ');
    const r = range ?? this.endRange();
    r.insertNode(space);
    r.insertNode(pill);
    this.placeCaretAfter(space);
    this.sync();
  }

  /** A `/` menu item: the typed `/query` goes, then the item runs where it was. */
  private slash(run: () => void): void {
    const range = this.popupRange;
    this.popup.set(null);
    if (range && this.box().nativeElement.contains(range.startContainer)) {
      range.deleteContents();
      const sel = this.selection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    this.sync();
    run();
  }

  calloutTitle(t: CalloutTone): string {
    return CALLOUT_TITLES[t];
  }

  // -------------------------------------------------------------------------------------------------------- templates

  editTemplates(): void {
    this.menu.set(null);
    this.templateDraft.set(this.templates().map((t) => ({ ...t })));
    this.editingTemplates.set(true);
  }

  editTemplate(i: number, name: string | null, text: string | null): void {
    this.templateDraft.update((all) => all.map((t, j) => (j === i ? { ...t, name: name ?? t.name, text: text ?? t.text } : t)));
  }

  addTemplate(): void {
    this.templateDraft.update((all) => [...all, { name: 'New template', icon: '▤', text: '### Heading\nText' }]);
  }

  resetTemplates(): void {
    saveTemplates(null);
    this.templates.set(DEFAULT_TEMPLATES);
    this.editingTemplates.set(false);
  }

  saveTemplateDraft(): void {
    const all = this.templateDraft().filter((t) => t.name.trim() && t.text.trim());
    saveTemplates(all);
    this.templates.set(all);
    this.editingTemplates.set(false);
  }

  // ----------------------------------------------------------------------------------------------------------- mentions

  flipDir(): void {
    this.dirChoice.set(nextChoice(this.dirChoice()));
    this.markBlockDirs();
  }

  /** Keeps the caret when the box loses focus (the @ Mention button, the picker), so a pick lands where the user was. */
  saveCaret(): void {
    this.popup.set(null);
    if (this.replacesAt) return;
    const sel = this.selection();
    if (sel && sel.rangeCount && this.box().nativeElement.contains(sel.anchorNode)) this.at = sel.getRangeAt(0).cloneRange();
  }

  openPicker(): void {
    this.saveCaret();
    this.replacesAt = false;
    this.pickerOpen.set(true);
  }

  /** The compact bar's "/": types a slash where the caret is, so the "/" menu opens as if typed. */
  typeSlash(): void {
    const box = this.box().nativeElement;
    box.focus();
    const sel = this.selection();
    if (this.at && sel) { sel.removeAllRanges(); sel.addRange(this.at); }
    const before = box.textContent ?? '';
    document.execCommand('insertText', false, before && !/\s$/.test(before) ? ' /' : '/');
    this.onInput();
  }

  closePicker(): void {
    this.pickerOpen.set(false);
    this.replacesAt = false;
    this.pickAction = null;
    this.firstPick = null;
    this.box().nativeElement.focus();
  }

  /** ✦ (specs/017 R38): what Claude may be asked about the selected text. */
  readonly askChoices: readonly { label: string; instruction: string }[] = [
    { label: '▤ Make it a chart', instruction: 'Turn this into a ```chart (or ```stats) block of the board - keep every number' },
    { label: '✂ Shorten it', instruction: 'Shorten this - same facts, half the words' },
    { label: 'ع Translate to Arabic', instruction: 'Translate this to Arabic; keep mentions, code and numbers as they are' },
    { label: '▦ As a table', instruction: 'Turn this into a Markdown table' },
    { label: '◈ As an HTML snippet', instruction: 'Show this as an ```html live snippet of the board (no network; alfred.data for live numbers)' },
  ];
  readonly asked = signal<{ id: string | null; instruction: string; answer: string | null; error: string | null; hadSelection: boolean } | null>(null);
  private askRange: Range | null = null;
  readonly canAsk = computed(() => !!(this.cycleId() || this.card()?.cycleId));

  askCustom(): void {
    const q = window.prompt('Ask Claude about the selected text:');
    if (q && q.trim()) void this.askClaude(q.trim());
  }

  /** Sends the selection (or the whole text) with the instruction to the cycle's chat; the answer comes back to accept. */
  async askClaude(instruction: string): Promise<void> {
    this.menu.set(null);
    const box = this.box().nativeElement;
    const sel = this.selection();
    const range = sel && sel.rangeCount && box.contains(sel.anchorNode) && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange()
      : this.at && box.contains(this.at.startContainer) && !this.at.collapsed ? this.at.cloneRange() : null;
    this.askRange = range;
    const selected = range ? range.toString() : '';
    const asks = this.injector.get(AskClaudeService);
    this.asked.set({ id: null, instruction, answer: null, error: null, hadSelection: !!range });
    try {
      const id = await asks.send({ kind: 'EDITOR', question: instruction, cardId: this.card()?.id ?? null, project: this.project() || this.card()?.project || null,
        cycleId: this.cycleId() ?? this.card()?.cycleId ?? null, data: { selection: selected || null, text: this.value().slice(0, 50_000), format: this.rich() ? 'html' : 'markdown' } });
      this.asked.update((a) => (a ? { ...a, id } : a));
      const answer = await asks.answer(id);
      this.asked.update((a) => (a && a.id === id ? { ...a, answer } : a));
    } catch (e) {
      this.asked.update((a) => (a ? { ...a, error: e instanceof Error ? e.message : 'Could not ask Claude' } : a));
    }
  }

  /** The answer into the text: in place of what was selected (or of the whole text), or below it. */
  acceptAsk(where: 'replace' | 'below'): void {
    const a = this.asked();
    if (!a?.answer) return;
    const box = this.box().nativeElement;
    let range: Range;
    if (where === 'replace' && !a.hadSelection) {
      box.replaceChildren();
      range = this.endRange();
    } else if (where === 'replace' && this.askRange && box.contains(this.askRange.startContainer)) {
      // the text asked about goes first, so the answer takes its place (the panel's click moved the selection away)
      range = this.askRange;
      range.deleteContents();
      range.collapse(true);
    } else {
      range = this.endRange();
    }
    if (document.activeElement !== box) box.focus();
    const sel = this.selection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    this.at = range.cloneRange();
    const answer = a.answer.replace(/\s+$/, '');
    const inline = !answer.includes('\n') && !hasFormatting(answer);
    if (inline || !this.toolbar()) {
      this.insertText(where === 'below' && box.textContent ? `\n${answer}` : answer);
      if (mentionsIn(answer).length) this.render(this.value());
    } else {
      this.insertBlocks(textBlocks(answer));
    }
    this.asked.set(null);
    this.askRange = null;
  }

  discardAsk(): void {
    const a = this.asked();
    if (a?.id && !a.answer && !a.error) this.injector.get(AskClaudeService).cancel(a.id);
    this.asked.set(null);
    this.askRange = null;
  }

  /** Data commands (specs/017 R40): each picks real calls, then writes the block that reads them live. */
  readonly dataCommands: readonly { id: string; label: string }[] = [
    { id: 'call', label: '⌁ /call - a call, opened in place' },
    { id: 'calls', label: '⌁ /calls - calls to an endpoint, live' },
    { id: 'sql', label: '◆ /sql - a statement and its rows' },
    { id: 'logs', label: '▤ /logs - the log lines of a call' },
    { id: 'compare', label: '⇆ /compare - two calls side by side' },
    { id: 'html', label: '◈ /html - an HTML snippet' },
    { id: 'page', label: '◈ /page - a whole-width HTML page' },
  ];
  /** What a pick from the picker is for: a mention (null), or a data command waiting for its call. */
  private pickAction: ((ref: MentionRef) => 'more' | void) | null = null;
  private firstPick: MentionRef | null = null;

  dataCommand(id: string): void {
    if (id === 'html') { this.visual('html'); return; }
    if (id === 'page') {
      this.saveCaret();
      this.visualEdit.set({ lang: 'html', source: VISUAL_TEMPLATES['html'] ?? '', info: 'live page name="Page"', pre: null });
      return;
    }
    const block = (lang: string, text: string): Block => ({ kind: 'visual', lang: lang as 'calls', info: '', text });
    const actions: Record<string, (ref: MentionRef) => 'more' | void> = {
      call: (ref) => this.insertBlocks([{ kind: 'callview', ref }]),
      calls: (ref) => this.insertBlocks([block('calls', `endpoint: ${endpointOf(ref.label)}\nsince: 24h\nshow: table(at, status, ms, sql, errors)`)]),
      sql: (ref) => this.insertBlocks([block('statement', `call: ${ref.ref}\nseq: 1\nrows: 50`)]),
      logs: (ref) => this.insertBlocks([block('call-logs', `call: ${ref.ref}\nlevel: WARN`)]),
      compare: (ref) => {
        if (!this.firstPick) {
          this.firstPick = ref;
          this.uploadError.set('Now pick the call to compare it with');
          this.pickerOpen.set(true);
          return 'more';
        }
        const first = this.firstPick;
        this.firstPick = null;
        this.insertBlocks([block('compare', `${serializeMention(first)}\n${serializeMention(ref)}`)]);
        return undefined;
      },
    };
    const action = actions[id];
    if (!action) return;
    this.pickAction = action;
    this.firstPick = null;
    this.uploadError.set(id === 'compare' ? 'Pick the first call' : null);
    this.openPicker();
  }

  /** A pick: a mention where the caret was, or the call a data command waited for. */
  picked(ref: MentionRef): void {
    const action = this.pickAction;
    if (!action) { this.insert(ref); return; }
    if (ref.type.toLowerCase() !== 'call') { this.uploadError.set('Pick a call for this block'); return; }
    this.pickerOpen.set(false);
    if (action(ref) === 'more') return;
    this.pickAction = null;
    this.uploadError.set(null);
  }

  /** Writes the pick as a pill in place of the `@` (or at the caret), followed by a space. */
  insert(ref: MentionRef): void {
    const box = this.box().nativeElement;
    let range = this.at && box.contains(this.at.startContainer) ? this.at : null;
    if (!range) {
      range = this.endRange();
    } else if (!this.replacesAt) {
      range.collapse(false);
    }
    range.deleteContents();
    const space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(mentionChipNode(document, ref));
    this.pickerOpen.set(false);
    this.replacesAt = false;
    this.at = null;
    this.sync();
    box.focus();
    this.placeCaretAfter(space);
  }

  /** Off to Live Calls / any cycle with the pick bar; the text so far, and where the @ was, ride along to come back to. */
  pickFromAnywhere(): void {
    const card = this.card();
    const field = this.pickField();
    if (!card || !field) return;
    const box = this.box().nativeElement;
    let at = this.value().length;
    if (this.at && box.contains(this.at.startContainer)) {
      if (this.replacesAt) this.at.deleteContents();
      at = this.offsetIn(this.at.startContainer, this.at.startOffset);
      this.sync();
    }
    this.pickerOpen.set(false);
    this.replacesAt = false;
    this.at = null;
    this.mentions.pickForCard(card, { kind: 'text', field, text: this.value(), at });
  }

  submit(): void {
    const text = this.value();
    if (!text.trim() && !this.allowEmpty()) return;
    this.clearDraft();
    this.submitted.emit(text);
  }

  // ------------------------------------------------------------------------------------------------------------ drafts

  private draftStoreKey(): string | null {
    const k = this.draftKey();
    return k ? `alfred.board.draft.${k}` : null;
  }

  private readDraft(): { text: string; at: number } | null {
    const k = this.draftStoreKey();
    if (!k) return null;
    try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; }
  }

  private saveDraft(text: string): void {
    const k = this.draftStoreKey();
    if (!k) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      try {
        if (text.trim()) localStorage.setItem(k, JSON.stringify({ text, at: Date.now() })); else localStorage.removeItem(k);
      } catch { /* private mode */ }
    }, 400);
  }

  private clearDraft(): void {
    const k = this.draftStoreKey();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftNotice.set(null);
    if (k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }
  }

  restoreDraft(): void {
    const d = this.draftNotice();
    this.draftNotice.set(null);
    if (!d) return;
    this.shown = null;
    this.value.set(d.text);
  }

  discardDraft(): void {
    this.clearDraft();
  }

  // ------------------------------------------------------------------------------------------------------- the box

  private render(text: string): void {
    const box = this.box().nativeElement;
    if (this.toolbar() && (isHtml(text) || hasFormatting(text))) {
      box.replaceChildren(...blocksToDom(textBlocks(text), document));
      this.rich.set(true);
    } else {
      renderMentionText(box, text);
      this.rich.set(false);
    }
    this.markBlockDirs();
    this.shown = text;
  }

  /** The box as text: plain while nothing is formatted (as always), else the board's HTML. */
  private serialize(): string {
    const box = this.box().nativeElement;
    const rich = this.toolbar() && Array.from(box.querySelectorAll('*')).some((e) => !isPlainElement(e as HTMLElement));
    this.rich.set(rich);
    if (!rich) return serializeMentionText(box);
    const blocks = domBlocks(box);
    // formatting all undone: back to plain text
    if (blocks.every((b) => b.kind === 'paragraph' && b.inlines.every((i) => i.kind === 'text' || i.kind === 'mention' || i.kind === 'br'))) {
      return blocks.map((b) => (b.kind === 'paragraph' ? b.inlines.map((i) => (i.kind === 'text' ? i.text.replace(/​/g, '') : i.kind === 'br' ? '\n' : serializeMention((i as { ref: MentionRef }).ref))).join('') : '')).join('\n');
    }
    return blocksToHtml(stripZeroWidth(blocks));
  }

  private sync(): void {
    const text = this.serialize();
    this.shown = text;
    this.value.set(text);
    this.markBlockDirs();
    this.saveDraft(text);
  }

  /** Each paragraph of rich text reads in its own direction as it is typed (or all in the forced one). */
  private markBlockDirs(): void {
    if (!this.rich()) return;
    const forced = this.dirChoice();
    this.box().nativeElement.querySelectorAll(BLOCK_SELECTOR).forEach((e) => {
      const dir = e.tagName === 'PRE' ? 'ltr' : forced !== 'auto' ? forced : textDir(e.textContent) ?? 'auto';
      if (e.getAttribute('dir') !== dir) e.setAttribute('dir', dir);
    });
  }

  private insertText(text: string): void {
    const sel = this.selection();
    const box = this.box().nativeElement;
    const node = document.createTextNode(text);
    if (!sel || !sel.rangeCount || !box.contains(sel.anchorNode)) {
      box.append(node);
    } else {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
    }
    // A trailing "\n" shows no new line in a contenteditable until something follows it.
    if (text.endsWith('\n') && !node.nextSibling) node.parentNode?.appendChild(fillerBreak(document));
    this.placeCaretAfter(node);
    this.sync();
  }

  /** Where node/offset falls in the stored text - so a pick from anywhere can come back to the same place. */
  private offsetIn(node: Node, offset: number): number {
    const marker = '';
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const probe = document.createTextNode(marker);
    range.insertNode(probe);
    const at = this.serialize().indexOf(marker);
    probe.remove();
    this.box().nativeElement.normalize();
    return at < 0 ? this.serialize().length : at;
  }

  private caretTextOffset(): number {
    const sel = this.selection();
    const box = this.box().nativeElement;
    if (!sel || !sel.rangeCount || !box.contains(sel.anchorNode)) return -1;
    const range = document.createRange();
    range.selectNodeContents(box);
    range.setEnd(sel.anchorNode!, sel.anchorOffset);
    return range.toString().replace(/\n/g, '').length;
  }

  private setCaretTextOffset(n: number): void {
    const box = this.box().nativeElement;
    if (n < 0) { this.caretToEnd(); return; }
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let left = n;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (t.parentElement?.closest('[contenteditable=false]')) { left -= t.data.length; continue; }
      if (left <= t.data.length) { this.placeCaret(t, Math.max(0, left)); return; }
      left -= t.data.length;
    }
    this.caretToEnd();
  }

  private closestIn(node: Node | null, selector: string): Element | null {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    const found = el?.closest(selector) ?? null;
    return found && this.box().nativeElement.contains(found) ? found : null;
  }

  /** The box focused with the selection where the user left it (the toolbar's select takes the focus for a moment). */
  private focusBox(): void {
    const box = this.box().nativeElement;
    const sel = this.selection();
    const range = sel && sel.rangeCount && box.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange()
      : this.at && box.contains(this.at.startContainer) ? this.at.cloneRange() : null;
    if (document.activeElement !== box) box.focus();
    sel?.removeAllRanges();
    sel?.addRange(range ?? this.endRange());
  }

  private endRange(): Range {
    const range = document.createRange();
    range.selectNodeContents(this.box().nativeElement);
    range.collapse(false);
    return range;
  }

  private placeCaret(node: Node, offset: number): void {
    const sel = this.selection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private placeCaretAfter(node: Node): void {
    const sel = this.selection();
    if (!sel) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private caretToEnd(): void {
    const sel = this.selection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(this.endRange());
  }

  private selection(): Selection | null {
    return this.box().nativeElement.ownerDocument.getSelection();
  }
}

/** What plain text is made of in the box: mention pills and line breaks (and the browser's bare div/p line wrappers). */
function isPlainElement(e: HTMLElement): boolean {
  if (e.closest('[data-mention]')) return true;
  if (e.tagName === 'BR') return true;
  return (e.tagName === 'DIV' || e.tagName === 'SPAN') && !e.attributes.length;
}

/** A paragraph's line breaks made into paragraphs - each line its own block, as the editor's Enter makes them. */
function splitAtBreaks(blocks: Block[]): Block[] {
  return blocks.flatMap((b): Block[] => {
    if (b.kind !== 'paragraph') return [b];
    const out: Inline[][] = [[]];
    for (const n of b.inlines) {
      if (n.kind === 'br') out.push([]); else out[out.length - 1].push(n);
    }
    return out.map((inlines) => ({ kind: 'paragraph', inlines }));
  });
}

function stripZeroWidth(blocks: Block[]): Block[] {
  const fix = (nodes: readonly Inline[]): Inline[] => nodes.map((n) => (n.kind === 'text' ? { ...n, text: n.text.replace(/​/g, '') }
    : 'children' in n ? { ...n, children: fix(n.children) } as Inline : n)).filter((n) => !(n.kind === 'text' && !n.text));
  return blocks.map((b): Block => {
    switch (b.kind) {
      case 'heading': case 'paragraph': case 'quote': return { ...b, inlines: fix(b.inlines) };
      case 'list': return { ...b, items: b.items.map(fix) };
      case 'table': return { ...b, header: b.header.map(fix), rows: b.rows.map((r) => r.map(fix)) };
      case 'callout': return { ...b, title: fix(b.title), blocks: stripZeroWidth([...b.blocks]) };
      case 'fold': return { ...b, summary: fix(b.summary), blocks: stripZeroWidth([...b.blocks]) };
      default: return b;
    }
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, '&quot;');
}

function clip(v: string): string {
  return v.length > 40 ? `${v.slice(0, 40)}…` : v;
}

/** `POST /fare · 500` → `POST /fare`: a picked call's label as the endpoint a ```calls``` block asks about. */
function endpointOf(label: string): string {
  const m = /^\s*([A-Z]+)\s+(\S+)/.exec(label);
  return m ? `${m[1]} ${m[2].replace(/\?.*$/, '')}` : label.split('·')[0].trim();
}
