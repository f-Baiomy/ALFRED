import { Component, computed, effect, inject, signal } from '@angular/core';
import { ExportDialogService, ExportFormat } from '../../core/services/export-dialog.service';
import { Environment, ExportFormData } from '../../core/models/export-metadata.model';
import { buildExportMarkdown, buildBulkExportMarkdown, exportFilename, bulkExportFilename } from '../../shared/utils/markdown-builder';
import { buildExportHtml, buildBulkExportHtml, exportHtmlFilename, bulkExportHtmlFilename } from '../../shared/utils/html-builder';
import { buildBulkExportPayload } from '../../shared/utils/bulk-json-builder';
import { buildDiscordReport } from '../../shared/utils/discord-report-builder';
import { downloadText, downloadJson } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';
import { copyToClipboard as writeTextToClipboard } from '../../shared/utils/clipboard';

/** The two report formats a user can toggle between inside the dialog - distinct from
 * ExportFormat, which also includes 'json' (a separate, non-toggleable export the dialog still
 * supports when opened that way, but never as part of this Markdown/HTML choice). */
type ReportFormat = 'markdown' | 'html';

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

  /** Which of Markdown/HTML is currently toggled in the dialog - independent of the format the
   * caller originally opened it with (state().format), which is now just the initial value; a
   * 'json' open never shows this toggle at all (see isJsonMode below), so this only matters for
   * the other two. */
  readonly reportFormat = signal<ReportFormat>('markdown');

  readonly copyFeedback = signal(false);
  readonly discordCopyFeedback = signal(false);

  private static readonly FORMAT_LABELS: Record<ExportFormat, string> = { markdown: 'Markdown', json: 'JSON', html: 'HTML' };
  private static readonly FORMAT_EXTENSIONS: Record<ExportFormat, string> = { markdown: '.md', json: '.json', html: '.html' };

  readonly isBulk = computed(() => (this.state()?.calls.length ?? 0) > 1);
  /** 'json' export (raw-data reprocessing, not a human-readable report) never offers the
   * Markdown/HTML toggle - it's a fundamentally different export, not a third format of the same
   * report. */
  readonly isJsonMode = computed(() => this.state()?.format === 'json');
  readonly effectiveFormat = computed<ExportFormat>(() => (this.isJsonMode() ? 'json' : this.reportFormat()));
  readonly formatLabel = computed(() => ExportDialogComponent.FORMAT_LABELS[this.effectiveFormat()]);
  readonly formatExtension = computed(() => ExportDialogComponent.FORMAT_EXTENSIONS[this.effectiveFormat()]);
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
        this.reportFormat.set(current.format === 'html' ? 'html' : 'markdown');
      },
      { allowSignalWrites: true }
    );
  }

  setEnvironment(env: Environment): void {
    this.environment.set(env);
  }

  setReportFormat(format: ReportFormat): void {
    this.reportFormat.set(format);
  }

  close(): void {
    this.dialogService.close();
  }

  confirmExport(): void {
    const built = this.buildContent(this.effectiveFormat());
    if (!built) return;

    if (built.isJson) {
      downloadJson(built.payload, built.filename);
    } else {
      downloadText(built.content, built.filename, built.mimeType);
    }

    this.close();
  }

  /** Always copies Markdown, even when the dialog's toggle is currently on HTML - HTML export is
   * a self-contained downloadable document (its own search/copy/syntax-highlighting baked in via
   * <script>), not something worth pasting into a chat message or ticket; Markdown reads cleanly
   * in both. 'json' export is a different case entirely (raw data, not a report) and keeps
   * copying JSON as-is. */
  copyToClipboard(): void {
    const built = this.buildContent(this.isJsonMode() ? 'json' : 'markdown');
    if (!built) return;

    const text = built.isJson ? JSON.stringify(built.payload, null, 2) : built.content;
    writeTextToClipboard(text).then(() => {
      this.copyFeedback.set(true);
      setTimeout(() => this.copyFeedback.set(false), 1200);
    });
  }

  /** The Discord bug-report template needs nothing beyond the same form fields already on this
   * dialog - it's a different arrangement of data the user already filled in, not a second form. */
  copyAsDiscordReport(): void {
    const report = buildDiscordReport(this.currentFormData());
    writeTextToClipboard(report).then(() => {
      this.discordCopyFeedback.set(true);
      setTimeout(() => this.discordCopyFeedback.set(false), 1200);
    });
  }

  private currentFormData(): ExportFormData {
    return {
      supplierName: this.supplierName(),
      credentialsUsed: this.credentialsUsed(),
      apiKey: this.apiKey(),
      url: this.url(),
      environment: this.environment(),
      description: this.description(),
    };
  }

  /** Shared by confirmExport/copyToClipboard so "what gets copied" always matches "what gets
   * downloaded" for whichever format is passed in - the caller decides which format that is,
   * since confirmExport respects the dialog's toggle while copyToClipboard deliberately doesn't. */
  private buildContent(format: ExportFormat):
    | { isJson: true; payload: unknown; filename: string }
    | { isJson: false; content: string; filename: string; mimeType: string }
    | null {
    const current = this.state();
    if (!current) return null;

    const form = this.currentFormData();
    const { calls, commentsByCallId } = current;

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
