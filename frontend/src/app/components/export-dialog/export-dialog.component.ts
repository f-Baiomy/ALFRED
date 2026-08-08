import { Component, computed, effect, inject, signal } from '@angular/core';
import { ExportDialogService, ExportFormat } from '../../core/services/export-dialog.service';
import { Environment } from '../../core/models/export-metadata.model';
import { buildExportMarkdown, buildBulkExportMarkdown, exportFilename, bulkExportFilename } from '../../shared/utils/markdown-builder';
import { buildExportHtml, buildBulkExportHtml, exportHtmlFilename, bulkExportHtmlFilename } from '../../shared/utils/html-builder';
import { buildBulkExportPayload } from '../../shared/utils/bulk-json-builder';
import { downloadText, downloadJson } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';

/**
 * One instance lives at the app root; ExportDialogService.state drives
 * whether it's visible, which call(s) it's exporting, and which format
 * (markdown or json). Opening a new export resets the form fields from the
 * first call's server-extracted metadata, but every field stays freely
 * editable - a client who receives this file may need to correct or fill in
 * fields the backend couldn't find.
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

  readonly copyFeedback = signal(false);

  private static readonly FORMAT_LABELS: Record<ExportFormat, string> = { markdown: 'Markdown', json: 'JSON', html: 'HTML' };
  private static readonly FORMAT_EXTENSIONS: Record<ExportFormat, string> = { markdown: '.md', json: '.json', html: '.html' };

  readonly isBulk = computed(() => (this.state()?.calls.length ?? 0) > 1);
  readonly formatLabel = computed(() => ExportDialogComponent.FORMAT_LABELS[this.state()?.format ?? 'markdown']);
  readonly formatExtension = computed(() => ExportDialogComponent.FORMAT_EXTENSIONS[this.state()?.format ?? 'markdown']);
  readonly totalFlaggedCount = computed(() => {
    const current = this.state();
    if (!current) return 0;
    return [...current.commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  });

  constructor() {
    effect(
      () => {
        const current = this.state();
        if (!current) return;
        const firstCall = current.calls[0];
        this.supplierName.set(current.metadata?.supplierName ?? '');
        this.credentialsUsed.set(current.metadata?.credentialsUsed ?? '');
        this.apiKey.set(current.metadata?.apiKey ?? '');
        this.url.set(current.metadata?.url ?? firstCall?.url ?? '');
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
    const built = this.buildContent();
    if (!built) return;

    if (built.isJson) {
      downloadJson(built.payload, built.filename);
    } else {
      downloadText(built.content, built.filename, built.mimeType);
    }

    this.close();
  }

  copyToClipboard(): void {
    const built = this.buildContent();
    if (!built) return;

    const text = built.isJson ? JSON.stringify(built.payload, null, 2) : built.content;
    navigator.clipboard.writeText(text).then(() => {
      this.copyFeedback.set(true);
      setTimeout(() => this.copyFeedback.set(false), 1200);
    });
  }

  /** Shared by confirmExport/copyToClipboard so "what gets copied" always matches "what gets downloaded". */
  private buildContent():
    | { isJson: true; payload: unknown; filename: string }
    | { isJson: false; content: string; filename: string; mimeType: string }
    | null {
    const current = this.state();
    if (!current) return null;

    const form = {
      supplierName: this.supplierName(),
      credentialsUsed: this.credentialsUsed(),
      apiKey: this.apiKey(),
      url: this.url(),
      environment: this.environment(),
      description: this.description(),
    };

    const { calls, commentsByCallId, format } = current;

    if (format === 'json') {
      const payload = buildBulkExportPayload(calls, form, commentsByCallId, new Date().toISOString());
      return { isJson: true, payload, filename: bulkExportFilename(calls, 'json') };
    }

    if (format === 'html') {
      if (calls.length === 1) {
        const call = calls[0];
        const html = buildExportHtml(call, form, commentsByCallId.get(callKey(call)) ?? []);
        return { isJson: false, content: html, filename: exportHtmlFilename(call), mimeType: 'text/html' };
      }
      const html = buildBulkExportHtml(calls, form, commentsByCallId, new Date().toISOString());
      return { isJson: false, content: html, filename: bulkExportHtmlFilename(calls), mimeType: 'text/html' };
    }

    if (calls.length === 1) {
      const call = calls[0];
      const markdown = buildExportMarkdown(call, form, commentsByCallId.get(callKey(call)) ?? []);
      return { isJson: false, content: markdown, filename: exportFilename(call), mimeType: 'text/markdown' };
    }

    const markdown = buildBulkExportMarkdown(calls, form, commentsByCallId, new Date().toISOString());
    return { isJson: false, content: markdown, filename: bulkExportFilename(calls, 'md'), mimeType: 'text/markdown' };
  }
}
