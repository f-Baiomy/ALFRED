/**
 * The ONE place this server reaches into the Angular app's source. Everything here is a pure
 * function or a type: the database findings and the exports must come from the same code the UI
 * runs, so Claude, the window and the files never disagree (research R4/R5). A rename in the
 * frontend breaks this file and `npm run typecheck`, nothing else.
 */
import './dom-shim.ts';

export type {
  CallRecord, CallDetail, CallDetailPart, CallSummaryDto, CallEndpointSource, SessionCycle, CallOverlapCandidate,
  CallResponse, HttpMessageData, CapturedCall,
} from '../../frontend/src/app/core/models/call.model.ts';
export type {
  CapturedStatement, CallStatementsPage, CallDbSummary, CallDbCapture, CallDbAnalysis, RecordedQueryRequest,
  RecordedQueryResult, TraceHit, RowsPage, DbFindingSummary, StatementTransaction, SupplierMarker, TypedValue, ExportedDbStatement,
} from '../../frontend/src/app/core/models/db-capture.model.ts';
export type { Comment, CommentBlock } from '../../frontend/src/app/core/models/comment.model.ts';
export type { Redaction } from '../../frontend/src/app/core/models/redaction.model.ts';
export type { ExportedCycle, ExportedSpacer, ExportFormData } from '../../frontend/src/app/core/models/export-metadata.model.ts';
export type { CycleSpacer } from '../../frontend/src/app/core/state/call-selection.tokens.ts';

export { toCallRecord, callTime, supplierOf } from '../../frontend/src/app/shared/utils/call-utils.ts';
export { analyzeCapture, suppliersOf } from '../../frontend/src/app/shared/utils/db-analysis.ts';
export { layoutSpacers, spacerSlots } from '../../frontend/src/app/shared/utils/spacer-gap-controller.ts';
export { redactCalls, redactSecrets, setSecretValues, REDACTED } from '../../frontend/src/app/shared/utils/redact.ts';
export { detectAndFormatBody } from '../../frontend/src/app/shared/utils/body-format.ts';
export type { ExportMetadata } from '../../frontend/src/app/core/models/export-metadata.model.ts';
export { buildExportFile, type ExportBuildFormat, type BuiltExport } from '../../frontend/src/app/shared/utils/export-build.ts';
