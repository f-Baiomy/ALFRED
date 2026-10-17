import { CallRecord } from '../models/call.model';
import { Redaction } from '../models/redaction.model';
import { buildBulkExportHtml } from '../../shared/utils/html-builder';
import { redactCalls } from '../../shared/utils/redact';

/**
 * Headers that never go to the tracker as they are (specs/028 FR-079, SC-007): on top of the user's own redactions, an
 * evidence file sent to Azure masks these on every call - unless the user ticks "send unmasked" for that file.
 */
export const ALWAYS_MASKED_HEADERS: readonly string[] = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
  'x-auth-token', 'x-alfred-team-token', 'x-alfred-call'];

/** The redactions an evidence file for the tracker uses: the user's, plus the always-masked headers both ways. */
export function azureRedactions(user: readonly Redaction[]): Redaction[] {
  const extra: Redaction[] = [];
  for (const name of ALWAYS_MASKED_HEADERS) {
    for (const kind of ['request-header', 'response-header'] as const) {
      extra.push({ id: `azure-${kind}-${name}`, scope: 'all', callId: null, kind, name, createdAt: '' });
    }
  }
  return [...user, ...extra];
}

/**
 * The evidence file a Tell Azure bundle attaches: the card's calls as Alfred's own HTML export - nothing cut - masked by
 * {@link azureRedactions} unless {@code unmasked}.
 */
export function azureEvidenceHtml(calls: readonly CallRecord[], user: readonly Redaction[], unmasked: boolean, title: string,
                                  exportedAt = new Date().toISOString()): string {
  const shown = unmasked ? calls : redactCalls(calls, azureRedactions(user)).calls;
  const description = `${title} - evidence from Alfred${unmasked ? ' (sent unmasked at the user\'s request)' : ' (secrets masked)'}`;
  return buildBulkExportHtml(shown, { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Local', description }, new Map(), exportedAt);
}
