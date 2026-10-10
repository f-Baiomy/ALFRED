import { LinkedLogLine } from '../../core/models/call-logs.model';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { ExportDialogService, ExportDialogState, ExportFormat } from '../../core/services/export-dialog.service';
import { Environment, ExportFormData } from '../../core/models/export-metadata.model';
import { buildExportFile, EXPORT_EXTENSIONS } from '../../shared/utils/export-build';
import { exportBlob } from '../../shared/utils/export-file-io';
import { buildDiscordReport } from '../../shared/utils/discord-report-builder';
import { downloadBlob, downloadText, downloadJson } from '../../shared/utils/download';
import { copyToClipboard as writeTextToClipboard } from '../../shared/utils/clipboard';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { redactCalls } from '../../shared/utils/redact';
import { readGroupByTransaction, saveGroupByTransaction } from '../../shared/utils/db-group-preference';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { CallDbCapture, CallDbSummary } from '../../core/models/db-capture.model';
import { CallRecord } from '../../core/models/call.model';
import { catchError, forkJoin, from, map, mergeMap, of, toArray } from 'rxjs';
import { CallsApiService } from '../../core/services/calls-api.service';
import { analyzeCapture, suppliersOf } from '../../shared/utils/db-analysis';
import { BoardExportService } from '../../core/services/board-export.service';
import { BoardExport, boardJsonFilename, buildBoardJsonLines } from '../../shared/utils/board-json';

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
  private readonly boardExport = inject(BoardExportService);
  private readonly dbCaptureApi = inject(DbCaptureApiService);
  private readonly callsApi = inject(CallsApiService);
  readonly state = this.dialogService.state;

  /**
   * "Include database statements" (docs/db-capture.md) - off on every open, so an export is today's file unless the
   * user asks. Offered only when some exported call was captured (`dbAvailable`, from the cheap summaries); ticking it
   * fetches every statement and stored row of those calls (exports never cut anything), and Export waits for them -
   * a file written before they arrived would silently lack its Database sections.
   */
  readonly includeDb = signal(false);
  /** A cycle export's board parts (specs/014-task-board FR-046): both off by default, so the file is what it always was. */
  readonly includeBrief = signal(false);
  readonly includeCards = signal(false);
  readonly loadingBoard = signal(false);
  /** .json only: write it gzip-compressed (.json.gz) - a fraction of the size; Alfred's import reads either. */
  readonly compressJson = signal(false);
  /** .json with database statements: every stored row (default), or the first rows of each statement only. */
  readonly rowsMode = signal<'all' | 'sample'>('all');
  /** How the included statements are laid out - the same remembered choice as the window's "Group by transaction". */
  readonly groupDb = signal(readGroupByTransaction());
  readonly dbAvailable = signal<{ readonly calls: number; readonly statements: number } | null>(null);
  private readonly dbCaptures = signal<ReadonlyMap<string, CallDbCapture>>(new Map());
  /** Each exported inbound call's linked log lines (specs/008-logs-call-link) - always part of the call, never cut. */
  private readonly logLines = signal<ReadonlyMap<string, readonly LinkedLogLine[]>>(new Map());
  readonly loadingLogs = signal(false);
  private readonly callLogsApi = inject(CallLogsApiService);
  readonly loadingDb = signal(false);
  private dbRequest = 0;

  /** The calls to export - with their database capture attached only when the user included it. */
  private readonly callsWithDb = computed<readonly CallRecord[]>(() => {
    const current = this.state();
    if (!current) return [];
    const logs = this.logLines();
    const calls = current.calls.map((c) => {
      const lines = logs.get(c.id);
      const plain = c.dbCapture ? { ...c, dbCapture: undefined } : c;
      return lines?.length ? { ...plain, logLines: lines } : plain;
    });
    const captures = this.dbCaptures();
    if (!this.includeDb() || !captures.size) return calls;
    const layout = this.groupDb() ? 'grouped' : 'flat';
    return calls.map((c) => (captures.has(c.id) ? { ...c, dbCapture: { ...captures.get(c.id)!, layout } } : c));
  });

  /** How many values the current selection would have masked, so the dialog can say so before the user commits to sending the file. */
  readonly redactedValueCount = computed(() => {
    const current = this.state();
    if (!current) return 0;
    return redactCalls(this.callsWithDb(), this.redactions.all()).redactedValueCount;
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
  readonly exportFeedback = signal(false);
  /** Which formats have been downloaded from this dialog session - drives the "Close" label and the hint, and resets when a new export opens (see the effect below). */
  private readonly exportedFormats = signal<ReadonlySet<ExportFormat>>(new Set());
  readonly hasExported = computed(() => this.exportedFormats().size > 0);
  readonly exportedLabel = computed(() =>
    [...this.exportedFormats()].map((f) => ExportDialogComponent.FORMAT_EXTENSIONS[f]).join(' and ')
  );
  readonly discordCopyFeedback = signal(false);

  private static readonly FORMAT_LABELS: Record<ExportFormat, string> = { markdown: 'Markdown', json: 'JSON', html: 'HTML', postman: 'Postman Collection' };
  private static readonly FORMAT_EXTENSIONS: Record<ExportFormat, string> = EXPORT_EXTENSIONS;

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
        this.exportedFormats.set(new Set());
        this.exportFeedback.set(false);
        this.reportFormat.set(current.format === 'html' ? 'html' : 'markdown');
        this.includeDb.set(false);
        this.groupDb.set(readGroupByTransaction());
        this.dbCaptures.set(new Map());
        this.loadingDb.set(false);
        this.dbRequest++;
        this.checkDbAvailable(current.calls, current.format);
        this.loadLogLines(current);
      },
      { allowSignalWrites: true }
    );
  }

  /** Only inbound calls can have captured statements; a Postman collection never carries them. */
  private capturable(calls: readonly CallRecord[], format: ExportFormat): CallRecord[] {
    return format === 'postman' ? [] : calls.filter((c) => c.source === 'internal');
  }

  /** Whether to offer the option at all, and what it would add - from the summaries, not the statements. */
  private checkDbAvailable(calls: readonly CallRecord[], format: ExportFormat): void {
    this.dbAvailable.set(null);
    const ids = this.capturable(calls, format).map((c) => c.id);
    if (!ids.length) return;
    const request = this.dbRequest;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
    from(chunks)
      .pipe(mergeMap((chunk) => this.dbCaptureApi.summaries(chunk).pipe(catchError(() => of({} as Record<string, CallDbSummary>))), 2), toArray())
      .subscribe((pages) => {
        if (request !== this.dbRequest) return;
        const found = pages.flatMap((p) => Object.values(p)).filter((s) => s.statementCount > 0);
        this.dbAvailable.set(found.length ? { calls: found.length, statements: found.reduce((n, s) => n + s.statementCount, 0) } : null);
      });
  }

  private logRequest = 0;

  private loadLogLines(current: ExportDialogState): void {
    const request = ++this.logRequest;
    this.logLines.set(new Map());
    const inbound = this.capturable(current.calls, current.format);
    if (!inbound.length) return;
    this.loadingLogs.set(true);
    const cycleId = current.cycle?.id ?? null;
    from(inbound)
      .pipe(mergeMap((call) => this.callLogsApi.allLines(call.id, cycleId).pipe(map((lines) => [call.id, lines] as const)), 4), toArray())
      .subscribe((pairs) => {
        if (request !== this.logRequest) return;
        this.logLines.set(new Map(pairs.filter(([, lines]) => lines.length)));
        this.loadingLogs.set(false);
      });
  }

  setGroupDb(grouped: boolean): void {
    this.groupDb.set(grouped);
    saveGroupByTransaction(grouped);
  }

  setIncludeDb(include: boolean): void {
    this.includeDb.set(include);
    const current = this.state();
    if (include && current && !this.dbCaptures().size && !this.loadingDb()) this.loadDbCaptures(current.calls, current.format);
  }

  private loadDbCaptures(calls: readonly CallRecord[], format: ExportFormat): void {
    const request = ++this.dbRequest;
    this.dbCaptures.set(new Map());
    const inbound = this.capturable(calls, format);
    if (!inbound.length) {
      this.loadingDb.set(false);
      return;
    }
    this.loadingDb.set(true);
    from(inbound)
      .pipe(
        // The capture, with where its time went (db-analysis.ts) - its supplier calls fetched by their parent link so
        // their time counts even when they are not part of this export.
        mergeMap((call) => forkJoin({
          capture: this.dbCaptureApi.exportCall(call.id),
          suppliers: this.callsApi.getChildren(call.id).pipe(catchError(() => of([] as CallRecord[]))),
        }).pipe(
          map(({ capture, suppliers }): readonly [string, CallDbCapture | null] =>
            [call.id, { ...capture, analysis: call.duration_ms ? analyzeCapture(call, capture, suppliersOf(call.id, suppliers)) : undefined }]),
          catchError(() => of([call.id, null] as const)), // 404: not captured
        ), 4),
        toArray(),
      )
      .subscribe((pairs) => {
        if (request !== this.dbRequest) return;
        this.dbCaptures.set(new Map(pairs.filter((p): p is readonly [string, CallDbCapture] => p[1] != null)));
        this.loadingDb.set(false);
      });
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

  /**
   * Deliberately does NOT close the dialog. One capture is routinely exported more than once - the
   * .md for a ticket and the .html for someone to actually read, or a second go after correcting a
   * metadata field - and closing on the first click made each of those a full re-open: reselect the
   * calls, reopen the dialog, retype the form. Since nothing visibly happens when a browser saves a
   * file, the button has to say so itself, or the dialog staying put reads as the export having
   * failed.
   */
  confirmExport(): void {
    if (this.includeDb() && this.loadingDb()) return;
    const cycle = this.state()?.cycle;
    if (cycle && (this.includeBrief() || this.includeCards())) {
      this.loadingBoard.set(true);
      void this.boardExport.gather('', cycle.id).then((data) => {
        this.loadingBoard.set(false);
        const board: BoardExport = {
          ...data,
          cards: this.includeCards() ? data.cards : [],
          activity: this.includeCards() ? data.activity : {},
          briefs: this.includeBrief() ? data.briefs : [],
          specs: this.includeBrief() ? data.specs : [],
          marks: this.includeBrief() ? data.marks : [],
        };
        this.writeExport(board, cycle.name);
      }, () => this.loadingBoard.set(false));
      return;
    }
    this.writeExport(null, null);
  }

  private writeExport(board: BoardExport | null, cycleName: string | null): void {
    const built = this.buildContent(this.effectiveFormat(), board && cycleName ? { data: board, title: `Board - ${cycleName}` } : null);
    if (!built) return;
    if (board && 'lines' in built) {
      // The .json stays the calls re-import format; the board goes beside it in its own alfred-board file.
      void exportBlob(buildBoardJsonLines(board), false).then((blob) => downloadBlob(blob, boardJsonFilename(board.project, cycleName)));
    }

    if ('lines' in built) {
      void exportBlob(built.lines, this.compressJson()).then((blob) =>
        downloadBlob(blob, this.compressJson() ? `${built.filename}.gz` : built.filename));
    } else if (built.isJson) {
      downloadJson(built.payload, built.filename);
    } else {
      downloadText(built.content, built.filename, built.mimeType);
    }

    this.exportedFormats.update((formats) => new Set([...formats, this.effectiveFormat()]));
    this.exportFeedback.set(true);
    setTimeout(() => this.exportFeedback.set(false), 1600);
  }

  /** Always copies Markdown, even when the dialog's toggle is currently on HTML - HTML export is
   * a self-contained downloadable document (its own search/copy/syntax-highlighting baked in via
   * <script>), not something worth pasting into a chat message or ticket; Markdown reads cleanly
   * in both. 'json'/'postman' export is a different case entirely (raw data, not a report) and
   * keeps copying that same raw data as-is. */
  copyToClipboard(): void {
    if (this.includeDb() && this.loadingDb()) return;
    const built = this.buildContent(this.isRawExportMode() ? this.state()!.format : 'markdown');
    if (!built) return;

    const text = 'lines' in built ? built.lines.join('\n') : built.isJson ? JSON.stringify(built.payload, null, 2) : built.content;
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
  private buildContent(format: ExportFormat, board: { readonly data: BoardExport; readonly title: string } | null = null):
    | { isJson: true; lines: string[]; filename: string }
    | { isJson: true; payload: unknown; filename: string }
    | { isJson: false; content: string; filename: string; mimeType: string }
    | null {
    const current = this.state();
    if (!current) return null;

    // Builder choice, masking and file naming live in buildExportFile, the one path the MCP server's
    // exports take too - so the two can never disagree on a file or skip Redactions.
    const built = buildExportFile(format, {
      calls: this.callsWithDb(),
      form: this.currentFormData(),
      commentsByCallId: current.commentsByCallId,
      overlapCandidates: current.overlapCandidates,
      statusFilter: current.statusFilter,
      cycle: current.cycle,
      spacers: current.spacers,
      listOrder: current.listOrder,
      redactions: this.redactions.all(),
      rows: this.rowsMode(),
      exportedAt: new Date().toISOString(),
      fileName: this.fileName(),
      board,
    });
    if (built.kind === 'lines') return { isJson: true, lines: built.lines, filename: built.filename };
    if (built.kind === 'payload') return { isJson: true, payload: built.payload, filename: built.filename };
    return { isJson: false, content: built.content, filename: built.filename, mimeType: built.mimeType };
  }
}
