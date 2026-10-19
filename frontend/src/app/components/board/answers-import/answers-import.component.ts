import { Component, HostListener, computed, effect, inject } from '@angular/core';
import { QuestionsFormService } from '../../../core/services/questions-form.service';
import { AnswerRow, VERDICT_LABEL } from '../../../core/models/questions-form.models';
import { AutoDirDirective } from '../../../shared/directives/auto-dir.directive';

/**
 * The answers file's report and Apply (specs/037 D17-D18), and the questions form's notes. Mounted once at the app root,
 * so the board's pill, a card and the chat open the same one. Everything shown comes from the JSON Alfred read out of
 * the file - the uploaded page itself is never rendered, framed or bound as HTML anywhere.
 */
@Component({
  selector: 'app-answers-import',
  standalone: true,
  imports: [AutoDirDirective],
  template: `
    @if (svc.pending(); as p) {
      <div class="dialog-backdrop" (click)="svc.close()">
        <div class="dialog-card aimp" role="dialog" aria-modal="true" aria-labelledby="aimp-title" (click)="$event.stopPropagation()">
          <h2 id="aimp-title">Answers file</h2>
          <p class="aimp-who"><bdi [appAutoDir]="p.report.file.answeredBy">{{ p.report.file.answeredBy || 'Someone' }}</bdi>@if (p.report.file.role) { (<bdi [appAutoDir]="p.report.file.role">{{ p.report.file.role }}</bdi>) }
            @if (p.report.file.answeredAt) { · {{ when(p.report.file.answeredAt) }} } · <span class="board-dim">{{ p.fileName }}</span>
            <span class="aimp-mode" [class.done]="!p.report.dryRun">{{ p.report.dryRun ? 'preview' : 'applied' }}</span></p>
          <div class="aimp-table" role="table">
            <div class="aimp-row aimp-head" role="row"><span role="columnheader">Card</span><span role="columnheader">Question</span><span role="columnheader">Answer</span><span role="columnheader">Result</span></div>
            @for (r of p.report.rows; track $index) {
              <div class="aimp-row" role="row">
                <span role="cell">{{ r.card != null ? '#' + r.card : '—' }}</span>
                <span role="cell" [appAutoDir]="r.question ?? ''"><b>{{ r.header ?? r.q }}</b>@if (r.question) { <span class="board-dim"> · {{ r.question }}</span> }</span>
                <span role="cell" [appAutoDir]="said(r)">{{ said(r) || '—' }}
                  @if (r.follow && r.follow.choice.length) { <span class="board-dim"> → {{ r.follow.header }}: {{ labels(r.follow.choice) }}</span> }
                  @if (r.note && (r.choice.length || r.later)) { <small class="aimp-note" [appAutoDir]="r.note">note: {{ r.note }}</small> }
                  @if (r.sure) { <small class="aimp-note">{{ sureLabel(r.sure) }}</small> }</span>
                <span role="cell"><span class="aimp-pill" [class]="'aimp-pill aimp-' + r.result.toLowerCase()">{{ verdict(r) }}</span>
                  @if (r.message) { <small class="aimp-note">{{ r.message }}</small> }</span>
              </div>
            }
          </div>
          @if (svc.note(); as n) { <p [class]="n.kind === 'error' ? 'dialog-error-note' : 'aimp-ok'">{{ n.text }}</p> }
          <div class="dialog-actions">
            @if (p.report.dryRun) {
              <button type="button" class="dialog-btn" (click)="svc.close()">Cancel</button>
              <button type="button" class="dialog-btn primary" [disabled]="!toApply() || svc.applying()" (click)="svc.apply()">
                {{ svc.applying() ? 'Applying…' : 'Apply ' + toApply() + ' answer' + (toApply() === 1 ? '' : 's') }}</button>
            } @else {
              <button type="button" class="dialog-btn primary" (click)="svc.close()">Done</button>
            }
          </div>
          <p class="board-dim aimp-foot">Answers are recorded on their cards as yours, with the file named. A question answered on the board already is never overwritten.</p>
        </div>
      </div>
    } @else {
      @if (svc.note(); as n) {
        <div class="aimp-toast" [class]="'aimp-toast aimp-toast-' + n.kind" role="status">{{ n.text }}
          <button type="button" class="board-link" aria-label="Dismiss" (click)="svc.note.set(null)">✕</button></div>
      }
    }`,
})
export class AnswersImportComponent {
  readonly svc = inject(QuestionsFormService);
  readonly toApply = computed(() => this.svc.pending()?.report.rows.filter((r) => r.result === 'APPLY').length ?? 0);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // a note on its own fades after a while; an error stays until dismissed
    effect(() => {
      const n = this.svc.note();
      if (this.timer) clearTimeout(this.timer);
      if (n && n.kind !== 'error' && !this.svc.pending()) this.timer = setTimeout(() => this.svc.note.set(null), 9000);
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.svc.pending()) this.svc.close();
  }

  said(r: AnswerRow): string {
    if (r.later) return 'later';
    const parts = r.choice.map((c) => c.label);
    if (r.other) parts.push('Other answer' + (r.note ? `: ${r.note}` : ''));
    return parts.length ? parts.join(', ') : r.note ?? '';
  }

  labels(c: readonly { label: string }[]): string {
    return c.map((x) => x.label).join(', ');
  }

  verdict(r: AnswerRow): string {
    return VERDICT_LABEL[r.result] ?? r.result;
  }

  sureLabel(s: string): string {
    return s === 'sure' ? 'sure' : s === 'likely' ? 'likely' : 'not sure';
  }

  when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }
}
