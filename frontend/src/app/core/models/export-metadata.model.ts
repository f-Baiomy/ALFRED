/** Best-effort metadata extracted server-side from a call, for pre-filling the export-as-Markdown form. Null fields mean the backend couldn't find that value - the form just leaves them empty and editable. */
export interface ExportMetadata {
  readonly supplierName: string | null;
  readonly credentialsUsed: string | null;
  readonly apiKey: string | null;
  readonly url: string | null;
}

/**
 * The session cycle an export was taken from, when it was taken from one whole cycle rather than a
 * hand-picked selection of calls (see CycleExportService). Carried into the export so the document
 * can say which capture it is - the cycle name is in practice the ticket title - and so re-importing
 * the .json can offer to recreate the cycle under that name instead of the user retyping it.
 *
 * Deliberately a snapshot of the cycle's own fields rather than a reference to it: the file outlives
 * the cycle, routinely on someone else's machine, where the id resolves to nothing.
 */
export interface ExportedCycle {
  readonly id: string;
  readonly name: string;
  readonly assignedTo: string | null;
  readonly status: string;
  readonly createdAt: string | null;
}

export type Environment = 'Production' | 'Staging';

export interface ExportFormData {
  readonly supplierName: string;
  readonly credentialsUsed: string;
  readonly apiKey: string;
  readonly url: string;
  readonly environment: Environment;
  readonly description: string;
}
