import { Component, effect, inject, signal } from '@angular/core';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { Environment } from '../../core/models/export-metadata.model';
import { buildExportMarkdown, exportFilename } from '../../shared/utils/markdown-builder';
import { downloadText } from '../../shared/utils/download';

/**
 * One instance lives at the app root; ExportDialogService.state drives
 * whether it's visible and which call it's exporting. Opening a new export
 * resets the form fields from that call's server-extracted metadata, but
 * every field stays freely editable - a client who receives this file may
 * need to correct or fill in fields the backend couldn't find.
 */
@Component({
  selector: 'app-export-dialog',
  standalone: true,
  templateUrl: './export-dialog.component.html',
})
export class ExportDialogComponent {
  private readonly dialogService = inject(ExportDialogService);
  readonly state = this.dialogService.state;

  readonly supplierName = signal('');
  readonly credentialsUsed = signal('');
  readonly apiKey = signal('');
  readonly url = signal('');
  readonly environment = signal<Environment>('Staging');
  readonly description = signal('');

  constructor() {
    effect(
      () => {
        const current = this.state();
        if (!current) return;
        this.supplierName.set(current.metadata?.supplierName ?? '');
        this.credentialsUsed.set(current.metadata?.credentialsUsed ?? '');
        this.apiKey.set(current.metadata?.apiKey ?? '');
        this.url.set(current.metadata?.url ?? current.call.url ?? '');
        this.environment.set('Staging');
        this.description.set('');
      },
      { allowSignalWrites: true }
    );
  }

  setEnvironment(env: Environment): void {
    this.environment.set(env);
  }

  close(): void {
    this.dialogService.close();
  }

  confirmExport(): void {
    const current = this.state();
    if (!current) return;

    const markdown = buildExportMarkdown(
      current.call,
      {
        supplierName: this.supplierName(),
        credentialsUsed: this.credentialsUsed(),
        apiKey: this.apiKey(),
        url: this.url(),
        environment: this.environment(),
        description: this.description(),
      },
      current.comments
    );

    downloadText(markdown, exportFilename(current.call));
    this.close();
  }
}
