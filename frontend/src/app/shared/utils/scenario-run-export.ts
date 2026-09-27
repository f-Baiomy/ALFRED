import { AssertionResult, DraftResult } from './scenario-types';
import { ResendDraft } from './resend-draft';
import { redactSecrets } from './redact';

/**
 * .md/.html export for one scenario run's report (D1 scenario-run-report). Follows the project's
 * hard no-truncation rule for call data - a failed draft's FULL request/response bodies are always
 * included, never summarized or clipped, same as every other export builder in this app.
 *
 * Full response bodies go through `redact.ts`'s `redactSecrets` before being written out, so a
 * secret global variable's value never leaks into a report just because the call that used it
 * failed its assertions.
 */
export { redactSecrets };

export interface ReportRow {
  readonly key: string;
  readonly label: string;
  readonly result: DraftResult;
  readonly assertions: readonly AssertionResult[];
  readonly passed: boolean;
}

export function rowsFor(drafts: readonly ResendDraft[], draftResults: readonly DraftResult[], assertionResults: Readonly<Record<string, readonly AssertionResult[]>>): ReportRow[] {
  const draftByKey = new Map(drafts.map((d) => [d.key, d]));
  return draftResults.map((result) => {
    const assertions = assertionResults[result.key] ?? [];
    const draft = draftByKey.get(result.key);
    return {
      key: result.key,
      label: draft ? `${draft.method} ${draft.url}` : result.key,
      result,
      assertions,
      passed: !result.error && assertions.every((a) => a.passed),
    };
  });
}

export function buildMarkdownReport(rows: readonly ReportRow[], scenarioName: string): string {
  const total = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const lines: string[] = [];
  lines.push(`# Scenario run: ${scenarioName}`);
  lines.push('');
  lines.push(`${passed} / ${total} drafts passed.`);
  lines.push('');
  for (const row of rows) {
    lines.push(`## ${row.passed ? '✅' : '❌'} ${row.label}`);
    lines.push('');
    lines.push(`- Status: ${row.result.status ?? '(none)'}`);
    lines.push(`- Duration: ${row.result.durationMs ?? '(none)'} ms`);
    if (row.result.error) lines.push(`- Error: ${row.result.error}`);
    if (row.assertions.length) {
      lines.push('- Assertions:');
      for (const a of row.assertions) {
        lines.push(`  - ${a.passed ? '✅' : '❌'} ${a.assertion.kind}${a.assertion.path ? ` \`${a.assertion.path}\`` : ''} ${a.assertion.operator}${a.assertion.value ? ` "${a.assertion.value}"` : ''} - ${a.message}`);
      }
    }
    if (!row.passed && row.result.response) {
      lines.push('');
      lines.push('Full response body:');
      lines.push('');
      lines.push('```');
      lines.push(redactSecrets(row.result.response.body ?? ''));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildHtmlReport(rows: readonly ReportRow[], scenarioName: string): string {
  const total = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const rowsHtml = rows
    .map((row) => {
      const assertionsHtml = row.assertions
        .map((a) => `<li>${a.passed ? '✅' : '❌'} ${escapeHtml(a.assertion.kind)}${a.assertion.path ? ` <code>${escapeHtml(a.assertion.path)}</code>` : ''} ${escapeHtml(a.assertion.operator)} - ${escapeHtml(a.message)}</li>`)
        .join('');
      const bodyHtml = !row.passed && row.result.response
        ? `<p>Full response body:</p><pre>${escapeHtml(redactSecrets(row.result.response.body ?? ''))}</pre>`
        : '';
      return `<section><h2>${row.passed ? '✅' : '❌'} ${escapeHtml(row.label)}</h2>
        <p>Status: ${row.result.status ?? '(none)'} · Duration: ${row.result.durationMs ?? '(none)'} ms${row.result.error ? ` · Error: ${escapeHtml(row.result.error)}` : ''}</p>
        <ul>${assertionsHtml}</ul>
        ${bodyHtml}</section>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scenario run: ${escapeHtml(scenarioName)}</title></head>
  <body><h1>Scenario run: ${escapeHtml(scenarioName)}</h1><p>${passed} / ${total} drafts passed.</p>${rowsHtml}</body></html>`;
}
