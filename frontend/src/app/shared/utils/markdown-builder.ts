import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment, CommentBlock, COMMENT_BLOCK_LABELS } from '../../core/models/comment.model';
import { tryParseJson } from './json-tokenizer';
import { callKey, supplierOf } from './call-utils';

function mdField(label: string, value: string): string {
  const display = value && value.trim().length > 0 ? value : '_(none provided)_';
  return `- **${label}:** ${display}`;
}

function commentsForBlock(comments: readonly Comment[], block: CommentBlock): Comment[] {
  return comments.filter((c) => c.block === block).sort((a, b) => a.lineIndex - b.lineIndex);
}

/**
 * Pretty-prints if the text is valid JSON, otherwise embeds it verbatim.
 * Deliberately never truncates or summarizes - this file gets handed to
 * another team to diagnose a bug, so partial data would be worse than no
 * export at all.
 *
 * Flagged lines get an inline `// FLAGGED: ...` marker appended, on top of
 * the dedicated "Flagged Issues" summary section below - the summary is
 * for scanning at a glance, the inline marker is for reading it in context
 * while looking at the actual data.
 */
function codeBlock(text: string | undefined, lineComments: readonly Comment[] = []): string {
  if (!text) return '```\n(empty)\n```';
  const parsed = tryParseJson(text);
  const lang = parsed.ok ? 'json' : '';
  const body = parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;

  if (lineComments.length === 0) {
    return `\`\`\`${lang}\n${body}\n\`\`\``;
  }

  const byLine = new Map<number, Comment[]>();
  for (const c of lineComments) {
    const list = byLine.get(c.lineIndex) ?? [];
    list.push(c);
    byLine.set(c.lineIndex, list);
  }

  const annotated = body
    .split('\n')
    .map((line, i) => {
      const onThisLine = byLine.get(i);
      if (!onThisLine) return line;
      const notes = onThisLine.map((c) => `FLAGGED: ${c.comment}`).join(' | ');
      return `${line}  // ⚠ ${notes}`;
    })
    .join('\n');

  return `\`\`\`${lang}\n${annotated}\n\`\`\``;
}

function headersBlock(headers: Readonly<Record<string, string>> | undefined, lineComments: readonly Comment[] = []): string {
  return codeBlock(JSON.stringify(headers ?? {}), lineComments);
}

const BLOCK_ORDER: readonly CommentBlock[] = ['request-headers', 'request-body', 'response-headers', 'response-body'];

function flaggedIssuesSection(comments: readonly Comment[]): string {
  if (comments.length === 0) return '';

  const lines: string[] = ['## Flagged Issues', ''];
  for (const block of BLOCK_ORDER) {
    const blockComments = commentsForBlock(comments, block);
    if (blockComments.length === 0) continue;

    lines.push(`### ${COMMENT_BLOCK_LABELS[block]}`, '');
    for (const c of blockComments) {
      lines.push(`- **Line ${c.lineIndex + 1}:** \`${c.lineText}\``);
      lines.push(`  > ${c.comment.replace(/\n/g, '\n  > ')}`);
    }
    lines.push('');
  }
  lines.push('---', '');

  return lines.join('\n');
}

export function buildExportMarkdown(call: CallRecord, form: ExportFormData, comments: readonly Comment[] = []): string {
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

  const flagged = flaggedIssuesSection(comments);
  if (flagged) {
    lines.push(flagged);
  }

  lines.push('## Request', '');
  lines.push(`- **Method:** \`${call.method}\``);
  lines.push(`- **Timestamp:** ${call.timestamp}`);
  if (call.duration_ms != null) {
    lines.push(`- **Duration:** ${call.duration_ms} ms`);
  }
  lines.push('', '### Headers', '');
  lines.push(headersBlock(call.request?.headers, commentsForBlock(comments, 'request-headers')));
  lines.push('', '### Body', '');
  lines.push(codeBlock(call.request?.body, commentsForBlock(comments, 'request-body')));
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
    lines.push(headersBlock(call.response.headers, commentsForBlock(comments, 'response-headers')));
    lines.push('', '### Body', '');
    lines.push(codeBlock(call.response.body, commentsForBlock(comments, 'response-body')));
  }
  lines.push('', '---', '');
  lines.push(`*Exported from Alfred/Manor*`);

  return lines.join('\n');
}

export function exportFilename(call: CallRecord): string {
  const supplier = supplierOf(call).replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${supplier}-${callKey(call)}.md`;
}
