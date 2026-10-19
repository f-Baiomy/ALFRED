import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { FormFormat, FormLang } from '../../../core/models/questions-form.models';
import { QuestionsFormService } from '../../../core/services/questions-form.service';

/**
 * The board's open-questions pill as a menu (specs/037 D2): answer them, download them as a questions form for someone
 * outside Alfred (in the language and file type chosen, remembered per board), show the cards, upload an answers file.
 * Closes on a click outside or Escape - never on the mouse leaving.
 */
@Component({
  selector: 'app-questions-menu',
  standalone: true,
  template: `
    <span class="qmenu">
      <button type="button" class="board-qpill board-qpill-total" aria-haspopup="menu" [attr.aria-expanded]="open()"
              title="Claude's open questions on these cards - answer, or send them as a form" (click)="open.set(!open())">
        ❓ {{ total() }} open question{{ total() === 1 ? '' : 's' }} on {{ cards() }} card{{ cards() === 1 ? '' : 's' }} ▾</button>
      @if (open()) {
        <div class="qmenu-pop" role="menu">
          <button type="button" role="menuitem" [disabled]="!editable()" (click)="open.set(false); answer.emit()">❓ Answer them here</button>
          <button type="button" role="menuitem" [disabled]="svc.busy()" title="One offline HTML file with every open question - for someone outside Alfred"
                  (click)="download()">⇩ Questions form: all {{ total() }} question{{ total() === 1 ? '' : 's' }}{{ svc.busy() ? '…' : '' }}</button>
          <button type="button" role="menuitem" (click)="open.set(false); showCards.emit()">☰ Show the {{ cards() }} card{{ cards() === 1 ? '' : 's' }}</button>
          <div class="qmenu-sep"></div>
          <button type="button" role="menuitem" [disabled]="!editable() || svc.busy()" title="The .html (or .zip) a questions form downloaded"
                  (click)="open.set(false); svc.pick(boardId(), project())">⇧ Upload answers file…</button>
          <div class="qmenu-sep"></div>
          <div class="qmenu-opts">
            <label>Language
              <select [value]="prefs().lang" (change)="setLang($any($event.target).value)">
                <option value="auto">Auto</option><option value="en">English</option><option value="ar">العربية</option>
              </select></label>
            <label>File
              <select [value]="prefs().format" (change)="setFormat($any($event.target).value)">
                <option value="html">.html</option><option value="zip">.zip</option>
              </select></label>
          </div>
          <p class="qmenu-hint">Auto: the language most questions are in - the reader can switch inside the form. .zip: for mail that blocks .html files.</p>
        </div>
      }
    </span>`,
})
export class QuestionsMenuComponent {
  readonly svc = inject(QuestionsFormService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly boardId = input.required<string>();
  readonly project = input('');
  readonly total = input(0);
  readonly cards = input(0);
  readonly editable = input(false);
  readonly answer = output<void>();
  readonly showCards = output<void>();
  /** Download the form with every open question - the board view makes one per board its cards live on. */
  readonly formAll = output<void>();

  readonly open = signal(false);
  private readonly version = signal(0);
  readonly prefs = computed(() => {
    this.version();
    return this.svc.prefs(this.boardId());
  });

  download(): void {
    this.open.set(false);
    this.formAll.emit();
  }

  setLang(lang: FormLang): void {
    this.svc.setPrefs(this.boardId(), { ...this.prefs(), lang });
    this.version.update((v) => v + 1);
  }

  setFormat(format: FormFormat): void {
    this.svc.setPrefs(this.boardId(), { ...this.prefs(), format });
    this.version.update((v) => v + 1);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }
}
