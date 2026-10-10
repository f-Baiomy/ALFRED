import { AfterViewInit, Component, ElementRef, computed, effect, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { MentionRef } from '../../../core/models/board.models';
import { BoardMentionsService, CardPickTarget, TextPickField } from '../../../core/services/board-mentions.service';
import { fillerBreak, mentionChipNode, renderMentionText, serializeMentionText, serializedOffset } from '../../../shared/utils/mention-dom';
import { mentionsIn } from '../../../shared/utils/mention-syntax';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';

/**
 * A Markdown text box with mentions (FR-022). Mentions show as small pills, not as their `@[type:ref|label]` text: the
 * box is a contenteditable where each mention is one non-editable chip (deleted as a whole), and `value` is always the
 * serialized text (shared/utils/mention-dom.ts). Typing `@` opens the picker at the caret; Ctrl+Enter submits; Enter is
 * a line break; a paste is plain text, its mentions turned into pills.
 */
@Component({
  selector: 'app-mention-editor',
  standalone: true,
  imports: [MentionPickerComponent],
  template: `
    <div class="board-editor">
      @if (pickerOpen()) {
        <app-mention-picker [project]="project()" [cycleId]="cycleId()" [calls]="callMentions()"
                            [canPickAnywhere]="!!card() && !!pickField()" (pickAnywhere)="pickFromAnywhere()"
                            (picked)="insert($event)" (closed)="closePicker()" />
      }
      <div #box class="board-editor-box" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true"
           [attr.data-placeholder]="placeholder()" [attr.aria-label]="placeholder()" [style.min-height.em]="rows() * 1.5"
           (input)="onInput()" (keydown)="onKeydown($event)" (paste)="onPaste($event)" (blur)="saveCaret()"></div>
      <div class="board-editor-hint">
        <span><kbd>&#64;</kbd> mention · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ submitLabel().toLowerCase() }} · Markdown</span>
        <span class="board-editor-actions">
          <button type="button" class="action-btn" title="Mention something" (mousedown)="$event.preventDefault()" (click)="openPicker()">&#64; Mention</button>
          @if (cancellable()) { <button type="button" class="action-btn" (click)="cancelled.emit()">Cancel</button> }
          <button type="button" class="action-btn primary" [disabled]="!value().trim() && !allowEmpty()" (click)="submit()">{{ submitLabel() }}</button>
        </span>
      </div>
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
  readonly placeholder = input('Write… type @ to mention a call, statement, log line, spec file…');
  readonly submitLabel = input('Comment');
  readonly cancellable = input(false);
  readonly allowEmpty = input(false);
  readonly rows = input(3);
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  private readonly mentions = inject(BoardMentionsService);
  readonly pickerOpen = signal(false);
  private readonly box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  /** The text this box last showed or produced - a value that differs came from outside and is rendered again. */
  private shown: string | null = null;
  private ready = false;
  /** Where a pick goes: the `@` that opened the picker (replaced by the pick), or the caret when the box was left. */
  private at: Range | null = null;
  private replacesAt = false;

  readonly callMentions = computed(() => {
    const seen = new Set<string>();
    return [...mentionsIn(this.value()), ...this.contextMentions()].filter((m) => {
      if (m.type.toLowerCase() !== 'call' || seen.has(m.ref)) return false;
      seen.add(m.ref);
      return true;
    });
  });

  constructor() {
    effect(() => {
      const text = this.value();
      untracked(() => {
        if (this.ready && text !== this.shown) this.render(text);
      });
    });
  }

  ngAfterViewInit(): void {
    this.ready = true;
    this.render(this.value());
  }

  onInput(): void {
    this.sync();
    const sel = this.selection();
    if (!sel || !sel.isCollapsed || sel.anchorNode?.nodeType !== Node.TEXT_NODE) return;
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
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
    } else if (event.key === 'Enter') {
      // A line break as "\n" in the text, not the <div> a browser would add.
      event.preventDefault();
      this.insertText('\n');
    }
  }

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    this.insertText(text);
    if (mentionsIn(text).length) {
      this.render(this.value());
      this.caretToEnd();
    }
  }

  /** Keeps the caret when the box loses focus (the @ Mention button, the picker), so a pick lands where the user was. */
  saveCaret(): void {
    if (this.replacesAt) return;
    const sel = this.selection();
    if (sel && sel.rangeCount && this.box().nativeElement.contains(sel.anchorNode)) this.at = sel.getRangeAt(0).cloneRange();
  }

  openPicker(): void {
    this.saveCaret();
    this.replacesAt = false;
    this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
    this.replacesAt = false;
    this.box().nativeElement.focus();
  }

  /** Writes the pick as a pill in place of the `@` (or at the caret), followed by a space. */
  insert(ref: MentionRef): void {
    const box = this.box().nativeElement;
    let range = this.at && box.contains(this.at.startContainer) ? this.at : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
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
      at = serializedOffset(box, this.at.startContainer, this.at.startOffset);
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
    this.submitted.emit(text);
  }

  private render(text: string): void {
    renderMentionText(this.box().nativeElement, text);
    this.shown = text;
  }

  private sync(): void {
    const text = serializeMentionText(this.box().nativeElement);
    this.shown = text;
    this.value.set(text);
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
    if (text.endsWith('\n') && !node.nextSibling) box.append(fillerBreak(document));
    this.placeCaretAfter(node);
    this.sync();
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
    const range = document.createRange();
    range.selectNodeContents(this.box().nativeElement);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private selection(): Selection | null {
    return this.box().nativeElement.ownerDocument.getSelection();
  }
}
