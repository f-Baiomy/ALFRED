import { CallRecord } from '../../core/models/call.model';
import { ActionType, RuleAction } from '../../core/models/interception.model';

/**
 * "Copy from a call…" for the body-shaped rule actions: take a logged call's request or response
 * and turn the parts the user ticks into this action's own fields plus, where the action cannot
 * hold a part itself, separate ordinary actions (one "Set header" per header, "Set method",
 * "Rewrite URL") - so everything copied is visible in the lane and editable or removable one by one.
 *
 * Pure: the component decides what is ticked, the rule editor applies the result.
 */

/** Which half is copied, and where it lands. */
export type CopyTarget =
  /** SET_REQUEST_BODY: body + content type on the action; headers/method/URL as extra request actions. */
  | 'request-body'
  /** SET_RESPONSE_BODY: body on the action; headers as extra response actions. */
  | 'response-body'
  /** MOCK_RESPONSE / REPLACE_RESPONSE: status, headers and body all on the action itself. */
  | 'response-whole';

export function copyTargetOf(type: ActionType): CopyTarget | null {
  switch (type) {
    case 'SET_REQUEST_BODY':
      return 'request-body';
    case 'SET_RESPONSE_BODY':
      return 'response-body';
    case 'MOCK_RESPONSE':
    case 'REPLACE_RESPONSE':
      return 'response-whole';
    default:
      return null;
  }
}

/**
 * Computed by the client or the connection, not part of what a call "says" - copying them into a
 * rule would pin a stale length or the wrong host onto every matching call.
 */
const NOT_COPYABLE = new Set(['content-length', 'host', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']);

/** Fallback when the backend's list has not loaded - the same names SensitiveHeaders.NAMES starts with. */
const DEFAULT_SECRETS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'api-key']);

export interface CopyableHeader {
  readonly name: string;
  readonly value: string;
  /** Carries a credential - unticked by default, and copying it puts it in the rule in plain text. */
  readonly secret: boolean;
}

export interface CopySource {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly headers: readonly CopyableHeader[];
  /** Headers left out because the proxy or client computes them. */
  readonly skipped: readonly string[];
  readonly body: string;
  readonly contentType: string;
}

export function copySourceOf(call: CallRecord, target: CopyTarget, sensitiveNames: ReadonlySet<string> | null): CopySource {
  const half = target === 'request-body' ? call.request : call.response;
  const secrets = sensitiveNames ?? DEFAULT_SECRETS;
  const headers: CopyableHeader[] = [];
  const skipped: string[] = [];
  let contentType = '';
  for (const [name, value] of Object.entries(half?.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'content-type') contentType = value;
    if (NOT_COPYABLE.has(lower)) {
      skipped.push(name);
      continue;
    }
    headers.push({ name, value, secret: secrets.has(lower) || DEFAULT_SECRETS.has(lower) });
  }
  return {
    method: call.method,
    url: call.url,
    status: call.response?.status ?? null,
    headers,
    skipped,
    body: half?.body ?? '',
    contentType,
  };
}

export interface CopyChoices {
  readonly body: boolean;
  /** request-body only - onto the action's contentType. */
  readonly contentType: boolean;
  /** response-whole only. */
  readonly status: boolean;
  /** request-body only - as a "Set method" action. */
  readonly method: boolean;
  /** request-body only - as a "Rewrite URL" action. */
  readonly url: boolean;
  /** By header name: ticked or not. */
  readonly headers: Readonly<Record<string, boolean>>;
}

/** Everything ticked except secrets, method and URL - the parts that change more than the payload are opt-in. */
export function defaultChoices(source: CopySource): CopyChoices {
  return {
    body: true,
    contentType: !!source.contentType,
    status: source.status != null,
    method: false,
    url: false,
    headers: Object.fromEntries(source.headers.map((h) => [h.name, !h.secret])),
  };
}

export interface CopyResult {
  /** Merged into the action the copy was started from. */
  readonly patch: Partial<RuleAction>;
  /** Inserted right after it, in order. */
  readonly extra: readonly RuleAction[];
}

export function buildCopy(source: CopySource, target: CopyTarget, choices: CopyChoices): CopyResult {
  const ticked = source.headers.filter((h) => choices.headers[h.name]);
  if (target === 'response-whole') {
    return {
      patch: {
        ...(choices.body ? { body: source.body } : {}),
        ...(choices.status && source.status != null ? { status: source.status } : {}),
        ...(ticked.length ? { headers: Object.fromEntries(ticked.map((h) => [h.name, h.value])) } : {}),
      },
      extra: [],
    };
  }

  const headerType: ActionType = target === 'request-body' ? 'SET_REQUEST_HEADER' : 'SET_RESPONSE_HEADER';
  const extra: RuleAction[] = ticked
    // The content type goes onto the body action itself when it can hold one - not twice.
    .filter((h) => !(target === 'request-body' && choices.contentType && h.name.toLowerCase() === 'content-type'))
    .map((h) => ({ type: headerType, name: h.name, value: h.value }));
  if (target === 'request-body') {
    if (choices.method) extra.push({ type: 'SET_METHOD', method: source.method });
    const rewrite = choices.url ? urlTargetOf(source.url) : null;
    if (rewrite) extra.push({ type: 'REWRITE_URL', target: rewrite });
  }
  return {
    patch: {
      ...(choices.body ? { body: source.body } : {}),
      ...(target === 'request-body' && choices.contentType && source.contentType ? { contentType: source.contentType } : {}),
    },
    extra,
  };
}

/** A URL as REWRITE_URL's target parts. The query stays the caller's own - the target has no query. */
function urlTargetOf(url: string): RuleAction['target'] | null {
  try {
    const u = new URL(url);
    return {
      scheme: u.protocol.replace(':', '') || null,
      host: u.hostname || null,
      port: u.port ? Number(u.port) : null,
      path: u.pathname || null,
    };
  } catch {
    return null;
  }
}
