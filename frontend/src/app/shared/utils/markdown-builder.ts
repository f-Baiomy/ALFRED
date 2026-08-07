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

function shortPath(url: string): string {
  try {
    return `.../${new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/')}`;
  } catch {
    return url;
  }
}

function statusCell(call: CallRecord): string {
  if (call.error) return `⚠️ ${call.error}`;
  return call.response ? String(call.response.status) : '?';
}

/**
 * One combined report for several calls at once - a summary table up top
 * (so a reader can scan status/duration before diving in) followed by every
 * call's full detail, in the same per-call shape buildExportMarkdown
 * already produces (Flagged Issues, Request, Response), just repeated and
 * anchored so the summary table's links land in the right place.
 */
export function buildBulkExportMarkdown(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>
): string {
  const lines: string[] = [];
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;
  const failed = calls.length - succeeded;
  const totalDurationMs = calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0);

  lines.push(`# API Calls Export (${calls.length} calls)`, '');
  lines.push(
    `**Overall:** ${succeeded} succeeded, ${failed} failed · **Total duration:** ${totalDurationMs.toFixed(2)} ms`,
    ''
  );

  lines.push('## Metadata', '');
  lines.push(mdField('Supplier Name', form.supplierName));
  lines.push(mdField('Supplier Credentials Used', form.credentialsUsed));
  lines.push(mdField('Environment', form.environment));
  lines.push(mdField('URL', form.url));
  lines.push(mdField('API Key', form.apiKey));
  lines.push(mdField('Description', form.description));
  lines.push('');

  lines.push('## Summary', '');
  lines.push('| # | Method | URL | Status | Duration | Flagged |', '|---|--------|-----|--------|----------|---------|');
  calls.forEach((call, i) => {
    const n = i + 1;
    const flaggedCount = commentsByCallId.get(callKey(call))?.length ?? 0;
    const duration = call.duration_ms != null ? `${call.duration_ms} ms` : '—';
    const flagged = flaggedCount > 0 ? `${flaggedCount} issue${flaggedCount === 1 ? '' : 's'}` : '—';
    lines.push(`| [${n}](#call-${n}) | ${call.method} | \`${shortPath(call.url)}\` | ${statusCell(call)} | ${duration} | ${flagged} |`);
  });
  lines.push('', '---', '');

  calls.forEach((call, i) => {
    const n = i + 1;
    const comments = commentsByCallId.get(callKey(call)) ?? [];

    lines.push(`## Call ${n}`, `<a id="call-${n}"></a>`, '');
    lines.push(`- **Method:** \`${call.method}\``);
    lines.push(`- **URL:** ${call.url}`);
    lines.push(`- **Timestamp:** ${call.timestamp}`);
    if (call.duration_ms != null) {
      lines.push(`- **Duration:** ${call.duration_ms} ms`);
    }
    lines.push('');

    const flagged = flaggedIssuesSection(comments);
    if (flagged) lines.push(flagged);

    lines.push('### Request', '');
    lines.push('#### Headers', '');
    lines.push(headersBlock(call.request?.headers, commentsForBlock(comments, 'request-headers')));
    lines.push('', '#### Body', '');
    lines.push(codeBlock(call.request?.body, commentsForBlock(comments, 'request-body')));
    lines.push('');

    if (call.error) {
      const suffix = call.response ? '' : ' No response was received for this call.';
      lines.push(`> ⚠️ **Error:** ${call.error}${suffix}`, '');
    }
    if (call.response) {
      lines.push('### Response', '');
      lines.push(`- **Status:** \`${call.response.status}\``);
      lines.push('', '#### Headers', '');
      lines.push(headersBlock(call.response.headers, commentsForBlock(comments, 'response-headers')));
      lines.push('', '#### Body', '');
      lines.push(codeBlock(call.response.body, commentsForBlock(comments, 'response-body')));
      lines.push('');
    }

    lines.push('---', '');
  });

  const totalFlagged = [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  lines.push(`*Exported from Alfred/Manor - ${calls.length} calls, ${totalFlagged} flagged issue${totalFlagged === 1 ? '' : 's'} total*`);

  return lines.join('\n');
}

export function bulkExportFilename(calls: readonly CallRecord[], extension: 'md' | 'json'): string {
  return `alfred-export-${calls.length}-calls.${extension}`;
}
