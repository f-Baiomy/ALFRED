import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { ExportedCycle, ExportedSpacer, ExportFormData } from '../../core/models/export-metadata.model';
import { Redaction } from '../../core/models/redaction.model';
import { CallStatusFilter } from './call-utils';
import { ExportListOrder } from './call-export-summary';
import { resolveExportFilename } from './download';
import { buildBulkExportHtml, buildExportHtml, bulkExportHtmlFilename, exportHtmlFilename } from './html-builder';
import { buildJsonExportV2 } from './json-export-v2';
import { buildBulkExportMarkdown, buildExportMarkdown, bulkExportCycleFilename, bulkExportFilename, exportFilename } from './markdown-builder';
import { buildBulkPostmanCollection, bulkPostmanFilename } from './postman-builder';
import { redactCalls } from './redact';

export type ExportBuildFormat = 'markdown' | 'json' | 'html' | 'postman';

export const EXPORT_EXTENSIONS: Record<ExportBuildFormat, string> = { markdown: '.md', json: '.json', html: '.html', postman: '.postman_collection.json' };

export interface ExportBuildInput {
  readonly calls: readonly CallRecord[];
  readonly form: ExportFormData;
  readonly commentsByCallId: ReadonlyMap<string, readonly Comment[]>;
  readonly overlapCandidates: readonly CallOverlapCandidate[];
  readonly statusFilter: CallStatusFilter;
  readonly cycle: ExportedCycle | null;
  readonly spacers: readonly ExportedSpacer[];
  readonly listOrder: ExportListOrder;
  readonly redactions: readonly Redaction[];
  /** .json only: every stored DB row, or the first rows of each statement. */
  readonly rows: 'all' | 'sample';
  readonly exportedAt: string;
  /** What the user typed as a file name - blank means the generated one. */
  readonly fileName: string;
}

export type BuiltExport =
  | { readonly kind: 'lines'; readonly lines: string[]; readonly filename: string; readonly redactedValueCount: number }
  | { readonly kind: 'payload'; readonly payload: unknown; readonly filename: string; readonly redactedValueCount: number }
  | { readonly kind: 'text'; readonly content: string; readonly filename: string; readonly mimeType: string; readonly redactedValueCount: number };

/**
 * Turns calls into one export file - the export dialog's and the MCP server's single path, so
 * neither can pick a different builder, name the file differently, or skip masking. Masking runs
 * first, here, and not inside the builders: six builders would be six chances to forget it, and
 * forgetting ships the user's bearer token to whoever they sent the file to.
 */
export function buildExportFile(format: ExportBuildFormat, input: ExportBuildInput): BuiltExport {
  const { form, commentsByCallId, overlapCandidates, statusFilter, cycle, exportedAt } = input;
  const { calls, redactedValueCount } = redactCalls(input.calls, input.redactions);
  const named = (generated: string) => resolveExportFilename(input.fileName, generated, EXPORT_EXTENSIONS[format]);

  if (format === 'json') {
    // Version 2 (json-export-v2.ts): one record per line with a guide and an index up front, normalised.
    const lines = buildJsonExportV2({ calls, form, commentsByCallId, exportedAt, overlapCandidates, statusFilter, redactedValueCount, cycle, rows: input.rows });
    return { kind: 'lines', lines, filename: named(cycle ? bulkExportCycleFilename(cycle, calls, 'json') : bulkExportFilename(calls, 'json')), redactedValueCount };
  }

  if (format === 'postman') {
    return { kind: 'payload', payload: buildBulkPostmanCollection(calls, form, exportedAt), filename: named(bulkPostmanFilename(calls)), redactedValueCount };
  }

  if (format === 'html') {
    // A whole-cycle export always takes the bulk path, even at one call: the single-call builders
    // produce a report ABOUT that call, with no place to state which cycle it is or that the
    // cycle is complete. A one-call cycle whose .json says "the complete cycle X" while its .md
    // says nothing of the sort is the same capture contradicting itself.
    if (calls.length === 1 && !cycle) {
      const call = calls[0];
      return { kind: 'text', content: buildExportHtml(call, form, commentsByCallId.get(call.id) ?? [], overlapCandidates), filename: named(exportHtmlFilename(call)), mimeType: 'text/html', redactedValueCount };
    }
    const html = buildBulkExportHtml(calls, form, commentsByCallId, exportedAt, overlapCandidates, statusFilter, cycle, input.spacers, input.listOrder);
    return { kind: 'text', content: html, filename: named(cycle ? bulkExportCycleFilename(cycle, calls, 'html') : bulkExportHtmlFilename(calls)), mimeType: 'text/html', redactedValueCount };
  }

  // See the html branch above for why a cycle export never takes this path.
  if (calls.length === 1 && !cycle) {
    const call = calls[0];
    return { kind: 'text', content: buildExportMarkdown(call, form, commentsByCallId.get(call.id) ?? [], overlapCandidates), filename: named(exportFilename(call)), mimeType: 'text/markdown', redactedValueCount };
  }
  const markdown = buildBulkExportMarkdown(calls, form, commentsByCallId, exportedAt, overlapCandidates, statusFilter, cycle, input.spacers, input.listOrder);
  return { kind: 'text', content: markdown, filename: named(cycle ? bulkExportCycleFilename(cycle, calls, 'md') : bulkExportFilename(calls, 'md')), mimeType: 'text/markdown', redactedValueCount };
}
