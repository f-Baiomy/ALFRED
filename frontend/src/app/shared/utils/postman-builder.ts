import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';

/** Postman Collection v2.1 schema - only the fields Alfred actually populates, not the full spec. */
interface PostmanHeader {
  readonly key: string;
  readonly value: string;
}

interface PostmanBody {
  readonly mode: 'raw';
  readonly raw: string;
  readonly options: { readonly raw: { readonly language: string } };
}

interface PostmanRequest {
  readonly method: string;
  readonly header: readonly PostmanHeader[];
  readonly body?: PostmanBody;
  readonly url: string;
}

interface PostmanResponse {
  readonly name: string;
  readonly originalRequest: PostmanRequest;
  readonly status: string;
  readonly code: number;
  readonly header: readonly PostmanHeader[];
  readonly body: string;
}

interface PostmanItem {
  readonly name: string;
  readonly request: PostmanRequest;
  readonly response: readonly PostmanResponse[];
}

export interface PostmanCollection {
  readonly info: {
    readonly name: string;
    readonly description: string;
    readonly schema: string;
  };
  readonly item: readonly PostmanItem[];
}

const COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Common reason phrases - Postman doesn't validate this string, but a real one reads better than the code repeated twice. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function toPostmanHeaders(headers: Readonly<Record<string, string>> | undefined): PostmanHeader[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

/** Picks a body syntax-highlighting language for Postman's editor from the request/response's own Content-Type header - defaults to plain text when there isn't one or it's unrecognized. */
function bodyLanguage(headers: Readonly<Record<string, string>> | undefined): string {
  const contentType = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? '';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  if (contentType.includes('html')) return 'html';
  return 'text';
}

function buildRequest(call: CallRecord): PostmanRequest {
  const body = call.request?.body
    ? { mode: 'raw' as const, raw: call.request.body, options: { raw: { language: bodyLanguage(call.request?.headers) } } }
    : undefined;

  return {
    method: (call.method || 'GET').toUpperCase(),
    header: toPostmanHeaders(call.request?.headers),
    ...(body ? { body } : {}),
    // A bare string is valid here per the v2.1 schema - Postman parses it into protocol/host/path/query on import, so there's no need to hand-decompose the URL ourselves.
    url: call.url || call.original_url || '',
  };
}

function buildItem(call: CallRecord): PostmanItem {
  const request = buildRequest(call);
  const response: PostmanResponse[] = call.response
    ? [{
        name: `${call.response.status} ${STATUS_TEXT[call.response.status] ?? 'Response'}`,
        originalRequest: request,
        status: STATUS_TEXT[call.response.status] ?? String(call.response.status),
        code: call.response.status,
        header: toPostmanHeaders(call.response.headers),
        body: call.response.body ?? '',
      }]
    : [];

  const supplierPrefix = call.supplierName ? `[${call.supplierName}] ` : '';
  return { name: `${supplierPrefix}${call.method} ${call.url}`, request, response };
}

/**
 * Every selected call becomes one Postman request item, with its actual recorded response (if
 * any) attached as a saved example - importing this collection into Postman gives a ready-to-run
 * (and re-editable) replay of the exact requests Alfred observed, with the real responses
 * available for reference without needing to re-send anything.
 */
export function buildBulkPostmanCollection(calls: readonly CallRecord[], form: ExportFormData, exportedAt: string): PostmanCollection {
  const namePrefix = form.supplierName ? `${form.supplierName} - ` : '';
  const descriptionLines = [
    form.description,
    form.credentialsUsed ? `Credentials: ${form.credentialsUsed}` : '',
    form.environment ? `Environment: ${form.environment}` : '',
    `Exported from Alfred: ${exportedAt}`,
  ].filter((line) => line.trim().length > 0);

  return {
    info: {
      name: `${namePrefix}Alfred export (${calls.length} call${calls.length === 1 ? '' : 's'})`,
      description: descriptionLines.join('\n'),
      schema: COLLECTION_SCHEMA,
    },
    item: calls.map(buildItem),
  };
}

export function bulkPostmanFilename(calls: readonly CallRecord[]): string {
  return `alfred-export-${calls.length}-calls.postman_collection.json`;
}
