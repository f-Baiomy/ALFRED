import { CallRecord } from '../../core/models/call.model';

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Builds a bash/zsh-style cURL command replaying this call against the real supplier (not the -proxy host). */
export function buildCurlCommand(call: CallRecord): string {
  const method = (call.method || 'GET').toUpperCase();
  const url = call.url || call.original_url || '';
  const parts = [`curl -X ${method} ${shQuote(url)}`];

  Object.entries(call.request?.headers || {}).forEach(([key, value]) => {
    parts.push(`-H ${shQuote(`${key}: ${value}`)}`);
  });

  if (call.request?.body) {
    parts.push(`--data-raw ${shQuote(call.request.body)}`);
  }

  return parts.join(' \\\n  ');
}

export interface BulkCurlMetadataHint {
  readonly supplierName?: string | null;
  readonly credentialsUsed?: string | null;
}

/**
 * A runnable shell script replaying every selected call in order, each
 * saving its response to its own file - useful for actually reproducing a
 * batch, not just documenting it. No per-call metadata form is involved
 * (unlike the .md/.json exports): this is a replay script, not a report.
 */
export function buildBulkCurlScript(calls: readonly CallRecord[], exportedAt: string, hint?: BulkCurlMetadataHint | null): string {
  const lines: string[] = [
    '#!/bin/sh',
    `# Alfred/Manor bulk export - ${calls.length} call${calls.length === 1 ? '' : 's'}`,
    `# Exported: ${exportedAt}`,
  ];

  if (hint?.supplierName || hint?.credentialsUsed) {
    lines.push(`# Supplier: ${hint.supplierName || '?'} | Credentials: ${hint.credentialsUsed || '?'}`);
  }
  lines.push('');

  calls.forEach((call, i) => {
    const n = i + 1;
    lines.push(`# --- Call ${n}: ${call.method} ${call.url} ---`);
    lines.push(`${buildCurlCommand(call)} \\\n  -o call-${n}-response.json`);
    lines.push('');
  });

  return lines.join('\n');
}

export function bulkCurlFilename(calls: readonly CallRecord[]): string {
  return `alfred-export-${calls.length}-calls.sh`;
}
