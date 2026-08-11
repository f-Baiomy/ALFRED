import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';

export interface BulkExportPayload {
  readonly metadata: ExportFormData;
  readonly exportedAt: string;
  readonly summary: {
    readonly callCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly totalDurationMs: number;
  };
  readonly calls: ReadonlyArray<CallRecord & { comments: readonly Comment[] }>;
}

/**
 * The .json counterpart to buildBulkExportMarkdown - same metadata and
 * per-call comments, structured for a machine to reprocess rather than a
 * person to read. exportedAt is passed in rather than computed here with
 * `new Date()`, so this stays a pure, easily-testable function.
 */
export function buildBulkExportPayload(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string
): BulkExportPayload {
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;

  return {
    metadata: form,
    exportedAt,
    summary: {
      callCount: calls.length,
      succeeded,
      failed: calls.length - succeeded,
      totalDurationMs: calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0),
    },
    calls: calls.map((call) => ({ ...call, comments: commentsByCallId.get(call.id) ?? [] })),
  };
}
