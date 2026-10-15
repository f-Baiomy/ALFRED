import type { AlfredClient } from './alfred-client.ts';
import {
  redactCalls, redactSecrets, setSecretValues, REDACTED,
  type CallDbCapture, type CallRecord, type Redaction, type RecordedQueryResult,
} from './frontend.ts';
import { session } from './session.ts';

/**
 * Masking for tool replies, when the user turns it on (FR-017f). It is the exports' own masking -
 * redact.ts's `redactCalls`, fed with Alfred's Redactions and the secret global variables, exactly
 * as the UI feeds it - so a reply hides precisely what an exported file would. Database data goes
 * through the same function with the capture attached to its call, so per-call `db-column` rules
 * reach params, rows and before-images; no reply path bypasses it.
 */

export interface MaskContext {
  readonly on: boolean;
  readonly redactions: readonly Redaction[];
  /** Values hidden so far by this tool call - every read reply reports it. */
  count: number;
}

export function resolveMask(override?: boolean): boolean {
  return override ?? session.maskSecrets;
}

interface VariablesState {
  readonly variables?: Record<string, string>;
  readonly fallbacks?: Record<string, string>;
  readonly secrets?: readonly string[];
}

/** Loads the rules once per tool call. Off → nothing is fetched and every helper is the identity. */
export async function maskContext(client: AlfredClient, override?: boolean): Promise<MaskContext> {
  if (!resolveMask(override)) return { on: false, redactions: [], count: 0 };
  const [redactions, variables] = await Promise.all([
    client.get<Redaction[]>('/redactions'),
    client.get<VariablesState>('/settings/variables').catch(() => ({} as VariablesState)),
  ]);
  // Same derivation as the UI's SecretValuesService: every value and fallback of a variable marked secret.
  const names = variables.secrets ?? [];
  setSecretValues(names.flatMap((name) => [variables.variables?.[name], variables.fallbacks?.[name]]).filter((v): v is string => typeof v === 'string'));
  return { on: true, redactions, count: 0 };
}

export function maskCalls(ctx: MaskContext, calls: readonly CallRecord[]): CallRecord[] {
  if (!ctx.on) return [...calls];
  const result = redactCalls(calls, ctx.redactions);
  ctx.count += result.redactedValueCount;
  return [...result.calls];
}

export function maskCall(ctx: MaskContext, call: CallRecord): CallRecord {
  return maskCalls(ctx, [call])[0];
}

/** A capture masked as part of its call - the only way `db-column` rules (scoped per call) apply. */
export function maskCapture(ctx: MaskContext, call: CallRecord, capture: CallDbCapture): CallDbCapture {
  if (!ctx.on) return capture;
  return maskCall(ctx, { ...call, dbCapture: capture }).dbCapture ?? capture;
}

/**
 * A SQL-search result has free-form columns, so it cannot go through redactCalls: a column named
 * by a `db-column` rule that applies to this call is blanked, and every other cell has the secret
 * values masked.
 */
export function maskQueryResult(ctx: MaskContext, callId: string, result: RecordedQueryResult): RecordedQueryResult {
  if (!ctx.on) return result;
  const hidden = new Set(ctx.redactions
    .filter((r) => r.kind === 'db-column' && (r.scope === 'all' || r.callId === callId))
    .map((r) => r.name.toLowerCase()));
  const hiddenIdx = new Set(result.columns.map((c, i) => (hidden.has(c.toLowerCase()) ? i : -1)).filter((i) => i >= 0));
  const rows = result.rows.map((row) => row.map((cell, i) => {
    if (cell === null) return cell;
    if (hiddenIdx.has(i)) {
      ctx.count++;
      return REDACTED;
    }
    const masked = redactSecrets(cell);
    if (masked !== cell) ctx.count++;
    return masked;
  }));
  return { ...result, rows };
}

/** For free text the server shows outside a call record (a value Claude traces, an error message). */
export function maskText(ctx: MaskContext, value: string): string {
  if (!ctx.on) return value;
  const masked = redactSecrets(value);
  if (masked !== value) ctx.count++;
  return masked;
}

export function maskMeta(ctx: MaskContext): { masked: boolean; maskedValues: number } {
  return { masked: ctx.on, maskedValues: ctx.count };
}

/**
 * Text the board chat sends to the terminal session (specs/022 FR-050, analysis C1): always masked, whatever the session's
 * setting - it is written to a chat log on disk. The secret values (as every reply masks them) and the shapes a secret
 * takes in prose: a bearer token, an Authorization / Cookie / Set-Cookie header, a password-like field, a JWT.
 */
const PROSE_SECRETS: readonly RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)(\s*[:=]\s*)[^\r\n]+/gi,
  /("?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
];

export function maskProseWith(ctx: MaskContext, text: string): string {
  let out = ctx.on ? redactSecrets(text) : text;
  out = out.replace(PROSE_SECRETS[0], (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PROSE_SECRETS[1], (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(PROSE_SECRETS[2], (_m, key: string) => `${key}${REDACTED}`)
    .replace(PROSE_SECRETS[3], REDACTED);
  if (out !== text) ctx.count++;
  return out;
}

/** Loads the masking rules forced on and masks `text` as prose for the terminal. */
export async function maskProse(client: AlfredClient, text: string): Promise<string> {
  return maskProseWith(await maskContext(client, true), text);
}
