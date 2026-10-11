import { Component, inject } from '@angular/core';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';

/** Styled replacement for window.confirm() - one instance lives per page, same pattern as ExportDialogComponent. */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  templateUrl: './confirm-dialog.component.html',
})
export class ConfirmDialogComponent {
  private readonly service = inject(ConfirmDialogService);
  readonly state = this.service.state;

  cancel(): void {
    this.service.respond(false);
  }

  pick(value: string): void {
    this.service.pick(value);
  }

  confirm(): void {
    this.service.respond(true);
  }
}
