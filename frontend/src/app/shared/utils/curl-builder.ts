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
