import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ResendEditorState, ResendMetadata } from '../../shared/model/resend';
import { ResendService } from '../../shared/services/resend.service';

/** Modal component: resend a call with optional header edits. */
@Component({
  selector: 'app-resend-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="resend-editor" *ngIf="visible">
      <div class="modal-overlay" (click)="close()"></div>
      <div class="modal-content">
        <h2>Resend Call</h2>
        <p class="call-info">Original Call: {{ state.originalCallId }}</p>

        <div class="headers-section">
          <h3>Modified Headers (optional)</h3>
          <p class="help-text">Select headers that differ from the original</p>
          <div class="common-headers">
            <label *ngFor="let header of commonHeaders">
              <input
                type="checkbox"
                [checked]="state.editedHeaders.has(header)"
                (change)="toggleHeader(header)"
              />
              {{ header }}
            </label>
          </div>
        </div>

        <div class="body-section" *ngIf="showBodyEditor">
          <h3>Request Body (optional)</h3>
          <textarea
            [(ngModel)]="state.requestBody"
            placeholder="Leave empty to use original body"
            rows="6"
          ></textarea>
        </div>

        <div class="actions">
          <button class="btn btn-cancel" (click)="close()">Cancel</button>
          <button class="btn btn-primary" (click)="submit()">Resend</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .resend-editor { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1000; }
    .modal-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); }
    .modal-content { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 2rem; border-radius: 8px; min-width: 500px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
    h2 { margin-top: 0; }
    .call-info { font-family: monospace; color: #666; padding: 0.5rem; background: #f5f5f5; border-radius: 4px; }
    .headers-section { margin: 2rem 0; }
    .common-headers { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
    .common-headers label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
    .body-section { margin: 2rem 0; }
    textarea { width: 100%; font-family: monospace; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem; }
    .actions { display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem; }
    .btn { padding: 0.5rem 1rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .btn-primary { background: #0066cc; color: white; }
    .btn-primary:hover { background: #0052a3; }
    .btn-cancel { background: #f0f0f0; color: #333; }
    .btn-cancel:hover { background: #e0e0e0; }
  `]
})
export class ResendEditorComponent implements OnInit {
  @Input() visible = false;
  @Input() callId: string = '';
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<ResendEditorState>();

  state: ResendEditorState = { originalCallId: '', editedHeaders: new Set() };
  commonHeaders = ['User-Agent', 'Accept', 'Accept-Language', 'Content-Type', 'Authorization'];
  showBodyEditor = false;

  constructor(private resendService: ResendService) {}

  ngOnInit() {
    if (this.callId) {
      this.resendService.getResendMetadata(this.callId).subscribe({
        next: (metadata) => {
          this.state.originalCallId = metadata.call_id;
        },
        error: () => {
          this.close();
        }
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
