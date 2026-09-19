import { Component, computed, effect, inject, signal } from '@angular/core';
import { ExportDialogService, ExportFormat } from '../../core/services/export-dialog.service';
import { Environment, ExportFormData } from '../../core/models/export-metadata.model';
import { buildExportMarkdown, buildBulkExportMarkdown, exportFilename, bulkExportFilename } from '../../shared/utils/markdown-builder';
import { buildExportHtml, buildBulkExportHtml, exportHtmlFilename, bulkExportHtmlFilename } from '../../shared/utils/html-builder';
import { buildBulkExportPayload } from '../../shared/utils/bulk-json-builder';
import { buildBulkPostmanCollection, bulkPostmanFilename } from '../../shared/utils/postman-builder';
import { buildDiscordReport } from '../../shared/utils/discord-report-builder';
import { downloadText, downloadJson, resolveExportFilename } from '../../shared/utils/download';
import { copyToClipboard as writeTextToClipboard } from '../../shared/utils/clipboard';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { redactCalls } from '../../shared/utils/redact';

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
  private readonly redactions = inject(RedactionsStore);
  readonly state = this.dialogService.state;

  /** How many values the current selection would have masked, so the dialog can say so before the user commits to sending the file. */
  readonly redactedValueCount = computed(() => {
    const current = this.state();
    if (!current) return 0;
    return redactCalls(current.calls, this.redactions.all()).redactedValueCount;
  });

  readonly supplierName = signal('');
  readonly credentialsUsed = signal('');
  readonly apiKey = signal('');
  readonly url = signal('');
  readonly environment = signal<Environment>('Staging');
  readonly description = signal('');
  /** Optional - blank means "use the generated name", exactly as before this field existed. See
   * resolveExportFilename() for how a non-blank value is turned into the actual downloaded name
   * (sanitized, and always given the export's real extension regardless of what was typed). */
  readonly fileName = signal('');

  /** Which of Markdown/HTML is currently toggled in the dialog - independent of the format the
   * caller originally opened it with (state().format), which is now just the initial value; a
   * 'json'/'postman' open never shows this toggle at all (see isRawExportMode below), so this
   * only matters for the other two. */
  readonly reportFormat = signal<ReportFormat>('markdown');

  readonly copyFeedback = signal(false);
  readonly discordCopyFeedback = signal(false);

  private static readonly FORMAT_LABELS: Record<ExportFormat, string> = { markdown: 'Markdown', json: 'JSON', html: 'HTML', postman: 'Postman Collection' };
  private static readonly FORMAT_EXTENSIONS: Record<ExportFormat, string> = { markdown: '.md', json: '.json', html: '.html', postman: '.postman_collection.json' };

  readonly isBulk = computed(() => (this.state()?.calls.length ?? 0) > 1);
  /** 'json' and 'postman' exports (raw data/tooling formats, not a human-readable report) never
   * offer the Markdown/HTML toggle - each is a fundamentally different export, not a third/fourth
   * format of the same report. */
  readonly isRawExportMode = computed(() => this.state()?.format === 'json' || this.state()?.format === 'postman');
  readonly effectiveFormat = computed<ExportFormat>(() =>
    this.isRawExportMode() ? this.state()!.format : this.reportFormat()
  );
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
        this.fileName.set('');
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
   * in both. 'json'/'postman' export is a different case entirely (raw data, not a report) and
   * keeps copying that same raw data as-is. */
  copyToClipboard(): void {
    const built = this.buildContent(this.isRawExportMode() ? this.state()!.format : 'markdown');
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
    const { commentsByCallId, overlapCandidates, statusFilter } = current;
    // The single place any export format gets its calls, so masking here covers markdown, HTML,
    // JSON and Postman at once - and covers a format added later without its author knowing this
    // exists. Deliberately not done inside the builders: six implementations is six chances to
    // forget one, and forgetting ships the user's bearer token to whoever they sent the file to.
    const { calls, redactedValueCount } = redactCalls(current.calls, this.redactions.all());

    if (format === 'json') {
      const payload = buildBulkExportPayload(calls, form, commentsByCallId, new Date().toISOString(), overlapCandidates, statusFilter, redactedValueCount);
      return { isJson: true, payload, filename: this.resolveFilename(bulkExportFilename(calls, 'json'), format) };
    }

    if (format === 'postman') {
      const payload = buildBulkPostmanCollection(calls, form, new Date().toISOString());
      return { isJson: true, payload, filename: this.resolveFilename(bulkPostmanFilename(calls), format) };
    }

    if (format === 'html') {
      if (calls.length === 1) {
        const call = calls[0];
        const html = buildExportHtml(call, form, commentsByCallId.get(call.id) ?? [], overlapCandidates);
        return { isJson: false, content: html, filename: this.resolveFilename(exportHtmlFilename(call), format), mimeType: 'text/html' };
      }
      const html = buildBulkExportHtml(calls, form, commentsByCallId, new Date().toISOString(), overlapCandidates, statusFilter);
      return { isJson: false, content: html, filename: this.resolveFilename(bulkExportHtmlFilename(calls), format), mimeType: 'text/html' };
    }

    if (calls.length === 1) {
      const call = calls[0];
      const markdown = buildExportMarkdown(call, form, commentsByCallId.get(call.id) ?? [], overlapCandidates);
      return { isJson: false, content: markdown, filename: this.resolveFilename(exportFilename(call), format), mimeType: 'text/markdown' };
    }

    const markdown = buildBulkExportMarkdown(calls, form, commentsByCallId, new Date().toISOString(), overlapCandidates, statusFilter);
    return { isJson: false, content: markdown, filename: this.resolveFilename(bulkExportFilename(calls, 'md'), format), mimeType: 'text/markdown' };
  }

  /** Applies whatever the user typed into the optional filename field, if anything, to a builder's
   * generated name - see resolveExportFilename(). `format`, not the generated name, decides the
   * real extension (FORMAT_EXTENSIONS), since a generated name routinely has its own dots earlier
   * in it (e.g. a supplier host like `host.docker.internal`) that make parsing "the" extension out
   * of the string itself unreliable. Copy-to-clipboard never downloads a file, so it has no
   * filename to resolve; only confirmExport()'s buildContent() call needs this. */
  private resolveFilename(defaultFilename: string, format: ExportFormat): string {
    return resolveExportFilename(this.fileName(), defaultFilename, ExportDialogComponent.FORMAT_EXTENSIONS[format]);
  }
}
