import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ResendEditorState } from '../../shared/model/resend';
import { ResendService } from '../../shared/services/resend.service';

/** Modal: resend a call with optional header edits. Reuses the app's global .dialog-* classes (see export-dialog) instead of its own stylesheet. */
@Component({
  selector: 'app-resend-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (visible) {
      <div class="dialog-backdrop" (click)="close()">
        <div class="dialog-card" (click)="$event.stopPropagation()">
          <h2>Resend Call</h2>
          <p class="dialog-sub">Original call: {{ state.originalCallId }}</p>

          <label class="dialog-field">
            <span>Modified headers (optional)</span>
            <div class="header-checks">
              @for (header of commonHeaders; track header) {
                <label>
                  <input type="checkbox" [checked]="state.editedHeaders.has(header)" (change)="toggleHeader(header)" />
                  {{ header }}
                </label>
              }
            </div>
          </label>

          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="close()">Cancel</button>
            <button type="button" class="dialog-btn primary" (click)="submit()">Resend</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`.header-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 1rem; margin-top: 0.4rem; }`]
})
export class ResendEditorComponent implements OnInit {
  @Input() visible = false;
  @Input() callId = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<ResendEditorState>();

  state: ResendEditorState = { originalCallId: '', editedHeaders: new Set() };
  commonHeaders = ['User-Agent', 'Accept', 'Accept-Language', 'Content-Type', 'Authorization'];

  constructor(private resendService: ResendService) {}

  ngOnInit() {
    if (this.callId) {
      this.resendService.getResendMetadata(this.callId).subscribe({
        next: (metadata) => (this.state.originalCallId = metadata.call_id),
        error: () => this.close()
      });
    }
  }

  toggleHeader(header: string) {
    if (this.state.editedHeaders.has(header)) {
      this.state.editedHeaders.delete(header);
    } else {
      this.state.editedHeaders.add(header);
    }
  }

  close() {
    this.closed.emit();
  }

  submit() {
    this.submitted.emit(this.state);
    this.close();
  }
}
