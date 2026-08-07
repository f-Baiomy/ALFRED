import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { tryParseJson } from './json-tokenizer';
import { callKey, supplierOf } from './call-utils';

function mdField(label: string, value: string): string {
  const display = value && value.trim().length > 0 ? value : '_(none provided)_';
  return `- **${label}:** ${display}`;
}

/**
 * Pretty-prints if the text is valid JSON, otherwise embeds it verbatim.
 * Deliberately never truncates or summarizes - this file gets handed to
 * another team to diagnose a bug, so partial data would be worse than no
 * export at all.
 */
function codeBlock(text: string | undefined): string {
  if (!text) return '```\n(empty)\n```';
  const parsed = tryParseJson(text);
  if (parsed.ok) {
    return `\`\`\`json\n${JSON.stringify(parsed.value, null, 2)}\n\`\`\``;
  }
  return `\`\`\`\n${text}\n\`\`\``;
}

function headersBlock(headers: Readonly<Record<string, string>> | undefined): string {
  return codeBlock(JSON.stringify(headers ?? {}));
}

export function buildExportMarkdown(call: CallRecord, form: ExportFormData): string {
  const lines: string[] = [];

  lines.push('# API Call Export', '');
  lines.push('## Metadata', '');
  lines.push(mdField('Supplier Name', form.supplierName));
  lines.push(mdField('Supplier Credentials Used', form.credentialsUsed));
  lines.push(mdField('Environment', form.environment));
  lines.push(mdField('URL', form.url));
  lines.push(mdField('API Key', form.apiKey));
  lines.push(mdField('Description', form.description));
  lines.push('', '---', '');

  lines.push('## Request', '');
  lines.push(`- **Method:** \`${call.method}\``);
  lines.push(`- **Timestamp:** ${call.timestamp}`);
  if (call.duration_ms != null) {
    lines.push(`- **Duration:** ${call.duration_ms} ms`);
  }
  lines.push('', '### Headers', '');
  lines.push(headersBlock(call.request?.headers));
  lines.push('', '### Body', '');
  lines.push(codeBlock(call.request?.body));
  lines.push('', '---', '');

  lines.push('## Response', '');
  if (call.error) {
    const suffix = call.response ? '' : ' No response was received for this call.';
    lines.push(`> ⚠️ **Error:** ${call.error}${suffix}`);
  }
  if (call.response) {
    if (call.error) lines.push('');
    lines.push(`- **Status:** \`${call.response.status}\``);
    lines.push('', '### Headers', '');
    lines.push(headersBlock(call.response.headers));
    lines.push('', '### Body', '');
    lines.push(codeBlock(call.response.body));
  }
  lines.push('', '---', '');
  lines.push(`*Exported from Alfred/Manor*`);

  return lines.join('\n');
}

export function exportFilename(call: CallRecord): string {
  const supplier = supplierOf(call).replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${supplier}-${callKey(call)}.md`;
}
