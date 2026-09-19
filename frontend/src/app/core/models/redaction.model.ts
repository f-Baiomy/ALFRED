/**
 * What a redaction points at. Deliberately a NAME (a header name, a JSON key, a query-param name)
 * and never a position or a value - see the `name` field below for why.
 */
export type RedactionKind =
  | 'request-header'
  | 'response-header'
  | 'request-body-key'
  | 'response-body-key'
  | 'url-param';

/** `call` hides this name on one call; `all` hides it on every call in every export. */
export type RedactionScope = 'call' | 'all';

export const REDACTION_KIND_LABELS: Record<RedactionKind, string> = {
  'request-header': 'Request header',
  'response-header': 'Response header',
  'request-body-key': 'Request body field',
  'response-body-key': 'Response body field',
  'url-param': 'URL parameter',
};

/** A user's decision to hide one named thing from exports. Never applied to the live UI - the value stays readable in Alfred, because you need it to debug; it is the shared artifact that leaks. */
export interface Redaction {
  readonly id: string;
  readonly scope: RedactionScope;
  /** Set for `call` scope, null for `all`. */
  readonly callId: string | null;
  readonly kind: RedactionKind;
  /**
   * The header name / JSON key / query-param name to hide - NEVER the secret itself.
   *
   * This is a security boundary, not a storage optimisation. Comments store `lineText`, and both
   * html-builder and markdown-builder echo that verbatim into the export's Flagged Issues section;
   * a redaction that stored the raw line would therefore reprint the secret in full, directly below
   * the masked copy, in the very file the user redacted in order to share safely. Storing only the
   * name also keeps secrets out of this store's own backups. Do not add a value field here.
   */
  readonly name: string;
  readonly createdAt: string;
}

export interface NewRedaction {
  readonly scope: RedactionScope;
  readonly callId: string | null;
  readonly kind: RedactionKind;
  readonly name: string;
}
