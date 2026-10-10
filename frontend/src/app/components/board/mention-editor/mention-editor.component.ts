import { Component, ElementRef, computed, inject, input, model, output, signal, viewChild } from '@angular/core';
import { MentionRef } from '../../../core/models/board.models';
import { BoardMentionsService, CardPickTarget, TextPickField } from '../../../core/services/board-mentions.service';
import { mentionsIn, serializeMention } from '../../../shared/utils/mention-syntax';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';

/**
 * A Markdown text box with mentions (FR-022): typing `@` opens the picker at the caret, and the pick is written in as
 * `@[type:ref|label]`. Mentions can also be typed by hand. Ctrl+Enter submits.
 */
@Component({
  selector: 'app-mention-editor',
  standalone: true,
  imports: [MentionPickerComponent],
  template: `
    <div class="board-editor">
      @if (pickerOpen()) {
        <app-mention-picker [project]="project()" [cycleId]="cycleId()" [calls]="callMentions()" [canPickAnywhere]="!!card() && !!pickField()" (pickAnywhere)="pickFromAnywhere()"
                            (picked)="insert($event)" (closed)="closePicker()" />
      }
      <textarea #box [placeholder]="placeholder()" [value]="value()" [rows]="rows()"
                (input)="onInput(box)" (keydown)="onKeydown($event)"></textarea>
      <div class="board-editor-hint">
        <span><kbd>&#64;</kbd> mention · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ submitLabel().toLowerCase() }} · Markdown</span>
        <span class="board-editor-actions">
          <button type="button" class="action-btn" title="Mention something" (click)="openPicker()">&#64; Mention</button>
          @if (cancellable()) { <button type="button" class="action-btn" (click)="cancelled.emit()">Cancel</button> }
          <button type="button" class="action-btn primary" [disabled]="!value().trim() && !allowEmpty()" (click)="submit()">{{ submitLabel() }}</button>
        </span>
      </div>
    </div>`,
})
export class MentionEditorComponent {
  readonly value = model('');
  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  /** Call mentions from around the editor (the card's links) - offered with the text's own for statements and lines. */
  readonly contextMentions = input<readonly MentionRef[]>([]);
  /** The card being written on, when there is one - with `pickField`, offers "Pick from anywhere". */
  readonly card = input<CardPickTarget | null>(null);
  /** Which of the card's texts this is, so calls picked elsewhere come back into it (the comment or the description). */
  readonly pickField = input<TextPickField | null>(null);
  private readonly mentions = inject(BoardMentionsService);
  readonly placeholder = input('Write… type @ to mention a call, statement, log line, spec file…');
  readonly submitLabel = input('Comment');
  readonly cancellable = input(false);
  readonly allowEmpty = input(false);
  readonly rows = input(3);
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  readonly pickerOpen = signal(false);
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  /** Where the `@` that opened the picker sits, so the pick replaces it. -1 when opened from the button. */
  private atIndex = -1;

  readonly callMentions = computed(() => {
    const seen = new Set<string>();
    return [...mentionsIn(this.value()), ...this.contextMentions()].filter((m) => {
      if (m.type.toLowerCase() !== 'call' || seen.has(m.ref)) return false;
      seen.add(m.ref);
      return true;
    });
  });

  onInput(box: HTMLTextAreaElement): void {
    this.value.set(box.value);
    const caret = box.selectionStart;
    if (box.value[caret - 1] === '@' && (caret === 1 || /\s/.test(box.value[caret - 2]))) {
      this.atIndex = caret - 1;
      this.pickerOpen.set(true);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
    }
  }

  /** Off to Live Calls / any cycle with the pick bar; the text so far, and where the @ was, ride along to come back to. */
  pickFromAnywhere(): void {
    const card = this.card();
    const field = this.pickField();
    if (!card || !field) return;
    const text = this.value();
    const at = this.atIndex >= 0 ? this.atIndex : text.length;
    const without = this.atIndex >= 0 ? text.slice(0, at) + text.slice(at + 1) : text;
    this.pickerOpen.set(false);
    this.mentions.pickForCard(card, { kind: 'text', field, text: without, at });
  }

  openPicker(): void {
    this.atIndex = -1;
    this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
    this.box().nativeElement.focus();
  }

  insert(ref: MentionRef): void {
    const box = this.box().nativeElement;
    const text = this.value();
    const mention = serializeMention(ref) + ' ';
    const start = this.atIndex >= 0 ? this.atIndex : box.selectionStart ?? text.length;
    const end = this.atIndex >= 0 ? this.atIndex + 1 : box.selectionEnd ?? text.length;
    const next = text.slice(0, start) + mention + text.slice(end);
    this.value.set(next);
    box.value = next;
    this.pickerOpen.set(false);
    const caret = start + mention.length;
    queueMicrotask(() => {
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  }

  submit(): void {
    const text = this.value();
    if (!text.trim() && !this.allowEmpty()) return;
    this.submitted.emit(text);
  }
}
