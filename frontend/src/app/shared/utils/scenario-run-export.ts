import { AssertionResult, DraftResult } from './scenario-types';
import { ResendDraft } from './resend-draft';
import { redactSecrets } from './redact';
import { escapeHtml, httpHtml, prettyBody, reportPage } from './relive-run-export';

/**
 * .md/.html export for one scenario run's report (D1 scenario-run-report), in the same readable
 * layout as the Relive run report (specs/export-redesign-mock.html): an answer first, "About this
 * document" for a reader who was not there, a table of every draft, one collapsed card per draft
 * with its checks, and a glossary.
 *
 * Follows the project's hard no-truncation rule for call data - a failed draft's FULL response body
 * is always included, never summarized or clipped, same as every other export builder in this app.
 * A passing draft's body stays out, as it always has.
 *
 * Bodies, headers and errors go through `redact.ts`'s `redactSecrets` before being written out, so a
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

// ---- What the report says, computed once for both formats

/** "POST https://api/x?y" -> its method + path, and the full URL. */
function nameOf(label: string): { readonly short: string; readonly url: string | null } {
  const space = label.indexOf(' ');
  if (space < 0) return { short: label, url: null };
  const method = label.slice(0, space);
  const url = label.slice(space + 1);
  try {
    const parsed = new URL(url);
    return { short: `${method} ${parsed.pathname}`, url: label };
  } catch {
    return { short: label, url: null };
  }
}

function checkText(a: AssertionResult): string {
  const { assertion } = a;
  return `${assertion.kind}${assertion.path ? ` ${assertion.path}` : ''} ${assertion.operator}${assertion.value ? ` "${assertion.value}"` : ''}`;
}

function whyFailed(row: ReportRow): string {
  if (row.result.error) return `error: ${redactSecrets(row.result.error)}`;
  const failed = row.assertions.filter((a) => !a.passed);
  return `${failed.length} of ${row.assertions.length} check${row.assertions.length === 1 ? '' : 's'} failed (${failed.map((a) => a.message).join('; ')})`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface ScenarioSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly checks: number;
  readonly checksPassed: number;
  readonly lead: string;
  readonly text: string;
  readonly good: boolean;
  readonly whatThisIs: string;
  readonly whatHappened: string;
  readonly howToRead: string;
}

function summarize(rows: readonly ReportRow[], scenarioName: string): ScenarioSummary {
  const total = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const failedRows = rows.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => !r.passed);
  const checks = rows.reduce((sum, r) => sum + r.assertions.length, 0);
  const checksPassed = rows.reduce((sum, r) => sum + r.assertions.filter((a) => a.passed).length, 0);
  const failures = failedRows.slice(0, 3).map(({ r, n }) => `${n} · ${nameOf(r.label).short} - ${whyFailed(r)}`);
  const good = failedRows.length === 0;
  return {
    total,
    passed,
    failed: failedRows.length,
    checks,
    checksPassed,
    good,
    lead: good ? `All ${total} drafts passed.` : `${passed} / ${total} drafts passed:`,
    text: good ? (checks ? `Every one of the ${checks} checks held.` : '') : `${failures.join('; ')}${failedRows.length > 3 ? `; and ${failedRows.length - 3} more` : ''}.`,
    whatThisIs: `The result of one run of the resend scenario "${scenarioName}" in ALFRED, a tool that records HTTP traffic and can send it again. A scenario is a saved list of ${total} request${total === 1 ? '' : 's'} (drafts), each copied from a logged call and possibly edited; a run sends them again in order and checks each answer against the draft's assertions.`,
    whatHappened: good
      ? `${passed} of ${total} drafts passed: every one answered without an error${checks ? ` and all ${checks} checks held` : ''}.`
      : `${passed} of ${total} drafts passed and ${failedRows.length} failed: ${joinList(failedRows.map(({ r, n }) => `draft ${n} (${nameOf(r.label).short})`))}. ${checks ? `${checksPassed} of ${checks} checks held.` : 'No draft had checks.'}`,
    howToRead: 'Every draft is listed in "All drafts", then has a card of its own with its status, duration, error and every check (what it expected and what came back). A failed draft carries its full response, never shortened; a passing one does not. Secret values are masked.',
  };
}

const GLOSSARY: readonly { readonly term: string; readonly meaning: string }[] = [
  { term: 'Scenario', meaning: 'A saved, ordered list of requests (drafts) that can be sent again together.' },
  { term: 'Draft', meaning: 'One request of a scenario, copied from a logged call and possibly edited before it is sent.' },
  { term: 'Assertion (check)', meaning: 'What a draft expects of its answer - a status, a header, a JSON field. A draft passes when it got an answer without error and every one of its checks held.' },
  { term: 'Extracted value', meaning: 'A value a draft saved from its answer for later drafts to send.' },
];

// ---- .md

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function buildMarkdownReport(rows: readonly ReportRow[], scenarioName: string): string {
  const s = summarize(rows, scenarioName);
  const lines: string[] = [];
  lines.push(`# Scenario run: ${scenarioName}`);
  lines.push('');
  lines.push(`> **${s.lead}** ${s.text}`.trimEnd());
  lines.push('');
  lines.push(`${s.passed} / ${s.total} drafts passed.`);
  lines.push('');
  lines.push('| Drafts | Passed | Failed | Checks held |', '| --- | --- | --- | --- |', `| ${s.total} | ${s.passed} | ${s.failed} | ${s.checksPassed} of ${s.checks} |`, '');
  lines.push('## About this document', '', `**What this is.** ${s.whatThisIs}`, '', `**What happened.** ${s.whatHappened}`, '', `**How to read it.** ${s.howToRead}`, '');
  lines.push('## All drafts', '', '| # | Draft | Outcome | Status | Duration | Checks |', '| --- | --- | --- | --- | --- | --- |');
  rows.forEach((row, i) => {
    const name = nameOf(row.label);
    lines.push(`| ${i + 1} | ${cell(name.short)}${name.url ? `<br>${cell(name.url)}` : ''} | ${row.passed ? '✅ passed' : '❌ failed'} | ${row.result.status ?? '(none)'} | ${row.result.durationMs ?? '(none)'} ms | ${row.assertions.length ? `${row.assertions.filter((a) => a.passed).length} of ${row.assertions.length}` : '-'} |`);
  });
  lines.push('', '## Drafts', '');
  rows.forEach((row, i) => {
    const name = nameOf(row.label);
    lines.push(`## ${row.passed ? '✅' : '❌'} ${row.label}`);
    lines.push('');
    lines.push(`<details><summary><b>${i + 1} · ${name.short}</b> - ${row.passed ? 'passed' : 'failed'} · ${row.result.status ?? 'no status'} · ${row.result.durationMs ?? '(none)'} ms</summary>`, '');
    lines.push(`- Status: ${row.result.status ?? '(none)'}`);
    lines.push(`- Duration: ${row.result.durationMs ?? '(none)'} ms`);
    if (row.result.attempt > 1) lines.push(`- Attempt: ${row.result.attempt}`);
    if (row.result.error) lines.push(`- Error: ${redactSecrets(row.result.error)}`);
    if (row.assertions.length) {
      lines.push('- Assertions:');
      for (const a of row.assertions) {
        lines.push(`  - ${a.passed ? '✅' : '❌'} ${a.assertion.kind}${a.assertion.path ? ` \`${a.assertion.path}\`` : ''} ${a.assertion.operator}${a.assertion.value ? ` "${a.assertion.value}"` : ''} - ${a.message}`);
      }
    }
    const extracted = Object.entries(row.result.extracted ?? {});
    if (extracted.length) {
      lines.push('- Values extracted:');
      for (const [k, v] of extracted) lines.push(`  - \`${k}\` = ${redactSecrets(v)}`);
    }
    if (!row.passed && row.result.response) {
      const body = redactSecrets(prettyBody(row.result.response.body ?? ''));
      lines.push('');
      lines.push('Full response body:');
      lines.push('');
      lines.push(fence(body, body.trim().startsWith('{') || body.trim().startsWith('[') ? 'json' : ''));
      const headers = Object.entries(row.result.response.headers ?? {});
      if (headers.length) {
        lines.push('', 'Response headers:', '', fence(headers.map(([k, v]) => `${k}: ${redactSecrets(String(v))}`).join('\n'), 'http'));
      }
    } else if (row.passed && row.result.response) {
      lines.push('', '*Response body not included - the draft passed.*');
    }
    lines.push('', '</details>', '');
  });
  lines.push('## Glossary', '', ...GLOSSARY.map((g) => `- **${g.term}** - ${g.meaning}`), '', '---', '', '*Generated by ALFRED. A failed draft\'s full response is included, never shortened. Secret values are masked.*', '');
  return lines.join('\n');
}

// ---- .html

export function buildHtmlReport(rows: readonly ReportRow[], scenarioName: string): string {
  const s = summarize(rows, scenarioName);
  const mask = (text: string) => redactSecrets(text);
  const toc = [
    '<b>This report</b>',
    '<a href="#summary">Summary</a><a href="#about">About this document</a><a href="#all-drafts">All drafts</a><a href="#glossary">Glossary</a>',
    '<b>Drafts</b>',
    ...rows.map((row, i) => `<a href="#draft-${i + 1}" title="${escapeHtml(row.label)}"><i class="dot ${row.passed ? 'ok' : 'fail'}"></i>${i + 1} ${escapeHtml(nameOf(row.label).short)}</a>`),
  ].join('');
  const tile = (n: string | number, label: string, color: string) => `<div class="tile"><b style="color:${color}">${n}</b><span>${label}</span></div>`;

  const cards = rows
    .map((row, i) => {
      const name = nameOf(row.label);
      const assertionsHtml = row.assertions.length
        ? `<h4>Assertions</h4><table class="t"><tr><th></th><th>Check</th><th>Result</th></tr>${row.assertions
            .map((a) => `<tr><td><span class="pill ${a.passed ? 'ok' : 'fail'}">${a.passed ? '✓' : '✗'}</span></td><td class="mono">${escapeHtml(checkText(a))}</td><td>${escapeHtml(a.message)}</td></tr>`)
            .join('')}</table>`
        : '<div class="dim">No assertions.</div>';
      const extracted = Object.entries(row.result.extracted ?? {});
      const extractedHtml = extracted.length
        ? `<h4>Values extracted</h4><table class="t"><tr><th>Name</th><th>Value</th></tr>${extracted.map(([k, v]) => `<tr><td class="mono">${escapeHtml(k)}</td><td class="mono">${escapeHtml(redactSecrets(v))}</td></tr>`).join('')}</table>`
        : '';
      const bodyHtml = !row.passed && row.result.response
        ? `<h4>Full response</h4>${httpHtml('Full response body', { status: row.result.response.status, headers: row.result.response.headers ?? {}, body: row.result.response.body ?? '' }, 'response', mask)}`
        : row.passed && row.result.response
          ? '<div class="dim">Response body not included - the draft passed.</div>'
          : '';
      return `<details class="step-fold" id="draft-${i + 1}" data-outcome="${row.passed ? 'passed' : 'failed'}"><summary class="step-head"><span class="num">${i + 1}</span><h3>${escapeHtml(name.short)}</h3><span class="pill ${row.passed ? 'ok' : 'fail'}">${row.passed ? '✓ passed' : '✗ failed'}</span>${
        name.url ? `<div class="url-line">${escapeHtml(name.url)}</div>` : ''
      }</summary><div class="step-body">${row.passed ? '' : `<div class="why-box"><b>Why it failed:</b> ${escapeHtml(whyFailed(row))}</div>`}
        <div class="facts"><div class="fact"><span>Status</span>${row.result.status ?? '(none)'}</div><div class="fact"><span>Duration</span>${row.result.durationMs ?? '(none)'} ms</div><div class="fact"><span>Attempt</span>${row.result.attempt}</div><div class="fact"><span>Error</span>${row.result.error ? escapeHtml(redactSecrets(row.result.error)) : 'none'}</div></div>
        ${assertionsHtml}${extractedHtml}${bodyHtml}</div></details>`;
    })
    .join('\n');

  const body = `<div id="summary"><div class="kicker">ALFRED · Scenario run report</div>
  <h1>Scenario run: ${escapeHtml(scenarioName)}</h1>
  <div class="meta"><span>${s.passed} / ${s.total} drafts passed.</span></div>
  <div class="verdict ${s.good ? 'good' : 'bad'}"><span class="lead">${escapeHtml(s.lead)}</span> ${escapeHtml(s.text)}</div>
  <div class="tiles">${tile(s.total, 'drafts', 'var(--text)')}${tile(s.passed, 'passed', 'var(--green)')}${tile(s.failed, 'failed', 'var(--red)')}${tile(`${s.checksPassed}/${s.checks}`, 'checks held', 'var(--cyan)')}</div></div>
  <section id="about"><h2>About this document</h2><div class="card about"><p><b>What this is.</b> ${escapeHtml(s.whatThisIs)}</p><p><b>What happened.</b> ${escapeHtml(s.whatHappened)}</p><p><b>How to read it.</b> ${escapeHtml(s.howToRead)}</p></div></section>
  <section id="all-drafts"><h2>All drafts</h2>
  <div class="filters"><button type="button" class="on" data-filter="all">All ${s.total}</button>${s.failed ? `<button type="button" data-filter="failed">Failed ${s.failed}</button>` : ''}${s.passed ? `<button type="button" data-filter="passed">Passed ${s.passed}</button>` : ''}</div>
  <table class="t"><tr><th>#</th><th>Draft</th><th>Outcome</th><th>Status</th><th>Duration</th><th>Checks</th></tr>${rows
    .map((row, i) => {
      const name = nameOf(row.label);
      return `<tr data-outcome="${row.passed ? 'passed' : 'failed'}"><td>${i + 1}</td><td class="name"><a href="#draft-${i + 1}">${escapeHtml(name.short)}</a>${name.url ? `<span class="url-sm">${escapeHtml(name.url)}</span>` : ''}</td><td><span class="pill ${row.passed ? 'ok' : 'fail'}">${row.passed ? '✓ passed' : '✗ failed'}</span></td><td class="mono">${row.result.status ?? '(none)'}</td><td class="mono">${row.result.durationMs ?? '(none)'} ms</td><td>${row.assertions.length ? `${row.assertions.filter((a) => a.passed).length} of ${row.assertions.length}` : '<span class="faint">-</span>'}</td></tr>`;
    })
    .join('')}</table></section>
  <section id="drafts"><h2>Drafts <small>every card starts closed - click one to open it</small></h2>${cards}</section>
  <section id="glossary"><h2>Glossary</h2><div class="card"><dl class="gloss">${GLOSSARY.map((g) => `<dt>${escapeHtml(g.term)}</dt><dd>${escapeHtml(g.meaning)}</dd>`).join('')}</dl></div></section>
  <div class="foot">Generated by ALFRED · a failed draft's full response is included, never shortened · secret values are masked.</div>`;
  return reportPage(`Scenario run: ${scenarioName}`, toc, body);
}
