import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Displays resend button/link in call detail view. */
@Component({
  selector: 'app-call-resend-link',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="resend-link" *ngIf="callId">
      <button
        class="btn-resend"
        (click)="openEditor()"
        [disabled]="loading()"
        title="Resend this call with optional header edits"
      >
        <span class="icon">⟳</span> Resend
      </button>
      <span class="resend-info" *ngIf="showResendInfo()">
        {{ resendCount() }} resend(s)
      </span>
    </div>
  `,
  styles: [`
    .resend-link { display: flex; align-items: center; gap: 1rem; margin: 0.5rem 0; }
    .btn-resend { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; background: #f0f0f0; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .btn-resend:hover:not(:disabled) { background: #e0e0e0; }
    .btn-resend:disabled { opacity: 0.5; cursor: not-allowed; }
    .icon { font-size: 1rem; }
    .resend-info { font-size: 0.85rem; color: #666; }
  `]
})
export class CallResendLinkComponent {
  @Input() callId: string = '';
  @Input() resendOfCallId: string | null = null;
  @Output() editorRequested = new EventEmitter<string>();

  loading = signal(false);
  showResendInfo = signal(false);
  resendCount = signal(0);

  openEditor() {
    this.editorRequested.emit(this.callId);
  }
}
