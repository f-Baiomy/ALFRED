/** Best-effort metadata extracted server-side from a call, for pre-filling the export-as-Markdown form. Null fields mean the backend couldn't find that value - the form just leaves them empty and editable. */
export interface ExportMetadata {
  readonly supplierName: string | null;
  readonly credentialsUsed: string | null;
  readonly apiKey: string | null;
  readonly url: string | null;
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
