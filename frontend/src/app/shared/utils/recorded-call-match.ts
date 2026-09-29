/**
 * What an outbound Relive child compares a live request against. The proxy
 * (interception.py GENERATED_REQUEST_HEADERS) ignores the same names.
 */
const GENERATED_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-connection', 'upgrade', 'te', 'trailer', 'date', 'accept-encoding',
  'user-agent', 'cookie', 'via', 'forwarded',
  'x-request-id', 'x-correlation-id', 'x-trace-id', 'x-operation-id',
  'x-alfred-relive', 'request-id', 'request-context',
  'traceparent', 'tracestate', 'x-amzn-trace-id', 'x-cloud-trace-context',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port',
]);

/** CorrelationId, traceparent, span id — a fresh value every call. Client-Id does not match. */
const TRACE_HEADER = /trace|correlation|request-?id|span-?id/i;

export function isGeneratedRequestHeader(name: string): boolean {
  const folded = name.toLowerCase();
  return GENERATED_REQUEST_HEADERS.has(folded) || folded.startsWith('x-b3-') || folded.startsWith('x-alfred-') || TRACE_HEADER.test(folded);
}

export interface RecordedCallPreview {
  readonly method: string;
  readonly url: string;
  readonly headerNames: readonly string[];
  readonly bodyNote: string;
}

export function bodyNote(body: string | null | undefined): string {
  const text = (body ?? '').trim();
  if (!text) return 'empty, spacing ignored';
  const head = text[0];
  if (head === '{' || head === '[') return 'JSON, spacing and formatting ignored';
  if (head === '<') return 'SOAP/XML, spacing and formatting ignored';
  return 'text, spacing ignored';
}

/** The URL, stable header names, and body note shown on an outbound child's call rule. */
export function recordedCallPreviewOf(call: {
  method?: string | null;
  url?: string | null;
  requestHeaders?: Readonly<Record<string, string>> | null;
  requestBody?: string | null;
} | null | undefined): RecordedCallPreview | null {
  if (!call?.method || !call.url) return null;
  const headerNames = Object.keys(call.requestHeaders ?? {})
    .filter((name) => !isGeneratedRequestHeader(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    method: call.method.toUpperCase(),
    url: call.url,
    headerNames,
    bodyNote: bodyNote(call.requestBody),
  };
}
