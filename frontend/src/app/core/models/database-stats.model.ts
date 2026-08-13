/** Counts of logged calls grouped by outcome - mirrors backend CallStatusBreakdown, drives the Database settings tab's status donut. */
export interface CallStatusBreakdown {
  readonly total: number;
  readonly ok: number;
  readonly clientError: number;
  readonly serverError: number;
}

/** One storage file's row count and on-disk size - one row per slice in the Database settings tab's file table. */
export interface DatabaseFileStats {
  readonly name: string;
  readonly rows: number;
  readonly sizeBytes: number;
}

/** GET /database/stats response. */
export interface DatabaseStatsResponse {
  readonly calls: CallStatusBreakdown;
  readonly files: readonly DatabaseFileStats[];
}
