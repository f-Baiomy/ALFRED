/**
 * The run export (.md/.json/.html, T079) - follows the project's hard no-truncation rule for call
 * data, same as `scenario-run-export.ts`: a step's full actual response body is always included,
 * never summarized or clipped. Masking reuses `relive-mask.ts`'s `maskRelive` (the same secret
 * handling every other Relive view uses), not `redact.ts`'s global rules.
 */
import { maskRelive } from './relive-mask';
import { RunComparison, StepSide, StepVerdict } from './relive-run-compare';
import { Step, StepResult } from './relive-types';

export interface RunReportRow {
  readonly step: Step;
  readonly result: StepResult | undefined;
}

export function rowsFor(steps: readonly Step[], results: Readonly<Record<string, StepResult>>): RunReportRow[] {
  return steps.map((step) => ({ step, result: results[step.key] }));
}

function bodyOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'body' in (value as Record<string, unknown>)) {
    const body = (value as { body?: unknown }).body;
    return typeof body === 'string' ? body : JSON.stringify(body ?? '', null, 2);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATE_ICON: Readonly<Record<StepResult['state'], string>> = {
  PENDING: '·',
  WAITING: '·',
  PAUSED: '⏸',
  RUNNING: '●',
  REPLAYED: '●',
  LIVE: '●',
  INTERCEPTED: '●',
  COMPLETED: '✅',
  COMPLETED_WITH_DIFFERENCES: '⚠️',
  FAILED: '❌',
  SKIPPED: '–',
  NOT_CALLED: '·',
  CANCELLED: '–',
};

export function buildMarkdownRunReport(rows: readonly RunReportRow[], cycleName: string, secretNames: readonly string[], variables: Readonly<Record<string, string>>): string {
  const mask = (text: string) => maskRelive(text, secretNames, variables);
  const total = rows.length;
  const completed = rows.filter((r) => r.result?.state === 'COMPLETED').length;
  const lines: string[] = [`# Relive run: ${cycleName}`, '', `${completed} / ${total} steps completed.`, ''];
  for (const row of rows) {
    const r = row.result;
    const icon = r ? STATE_ICON[r.state] : '·';
    lines.push(`## ${icon} ${row.step.label} (${r?.state ?? 'NOT_CALLED'})`, '');
    if (!r) {
      lines.push('');
      continue;
    }
    lines.push(`- Mode: ${r.mode}`, `- Attribution: ${r.attribution}`, `- Duration: ${r.durationMs ?? '(none)'} ms`);
    if (r.error) lines.push(`- Error: ${mask(r.error)}`);
    if (r.differences.length) {
      lines.push('- Differences:');
      for (const d of r.differences) {
        lines.push(`  - ${d.kind} \`${d.path}\`: ${mask(d.recorded ?? '')} → ${mask(d.actual ?? '')}`);
      }
    }
    lines.push('', 'Full actual response body:', '', '```', mask(bodyOf(r.actualResponse)), '```', '');
  }
  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildHtmlRunReport(rows: readonly RunReportRow[], cycleName: string, secretNames: readonly string[], variables: Readonly<Record<string, string>>): string {
  const mask = (text: string) => maskRelive(text, secretNames, variables);
  const total = rows.length;
  const completed = rows.filter((r) => r.result?.state === 'COMPLETED').length;
  const sections = rows
    .map((row) => {
      const r = row.result;
      const icon = r ? STATE_ICON[r.state] : '·';
      if (!r) return `<section><h2>${icon} ${escapeHtml(row.step.label)} (NOT_CALLED)</h2></section>`;
      const diffsHtml = r.differences.length
        ? `<ul>${r.differences.map((d) => `<li>${escapeHtml(d.kind)} <code>${escapeHtml(d.path)}</code>: ${escapeHtml(mask(d.recorded ?? ''))} → ${escapeHtml(mask(d.actual ?? ''))}</li>`).join('')}</ul>`
        : '';
      return `<section><h2>${icon} ${escapeHtml(row.step.label)} (${escapeHtml(r.state)})</h2>
        <p>Mode: ${escapeHtml(r.mode)} · Attribution: ${escapeHtml(r.attribution)} · Duration: ${r.durationMs ?? '(none)'} ms${r.error ? ` · Error: ${escapeHtml(mask(r.error))}` : ''}</p>
        ${diffsHtml}
        <p>Full actual response body:</p><pre>${escapeHtml(mask(bodyOf(r.actualResponse)))}</pre></section>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relive run: ${escapeHtml(cycleName)}</title></head>
  <body><h1>Relive run: ${escapeHtml(cycleName)}</h1><p>${completed} / ${total} steps completed.</p>${sections}</body></html>`;
}

/** The .json export never masks - it's the re-import/reprocessing format, same rule the rest of
 *  ALFRED's exports follow (masking is a display concern, not a data concern). */
export function buildJsonRunReport(cycleName: string, rows: readonly RunReportRow[]): string {
  return JSON.stringify(
    {
      cycleName,
      steps: rows.map((row) => ({ stepKey: row.step.key, label: row.step.label, result: row.result ?? null })),
    },
    null,
    2,
  );
}

// ---- Comparing two runs (T134) ----

/** How a side of a comparison is named in an export: "Run of 2026-10-02T16:16:00Z" or "The recording". */
export interface CompareReportSides {
  readonly a: string;
  readonly b: string;
}

const VERDICT_TEXT: Readonly<Record<StepVerdict, string>> = {
  NEW_FAILURE: 'new failure',
  FIXED: 'fixed',
  CHANGED: 'answer changed',
  NOT_RUN: 'ran in only one',
  SLOWER: 'slower',
  FASTER: 'faster',
  SAME: 'same',
};

function sideLine(side: StepSide): string {
  if (side.outcome === 'skip') return 'not run';
  return `${side.outcome} · status ${side.status ?? '(none)'} · ${side.durationMs ?? '(none)'} ms${side.mode ? ` · ${side.mode}` : ''}${side.error ? ` · error: ${side.error}` : ''}`;
}

/** Every step, both full response bodies - a comparison export never truncates call data either. */
export function buildMarkdownCompareReport(cmp: RunComparison, cycleName: string, sides: CompareReportSides, secretNames: readonly string[], variables: Readonly<Record<string, string>>): string {
  const mask = (text: string) => maskRelive(text, secretNames, variables);
  const lines: string[] = [
    `# Relive run comparison: ${cycleName}`, '',
    `- A: ${sides.a}`, `- B: ${sides.b}`, '',
    `**${cmp.verdict.lead}** ${cmp.verdict.text}`, '',
  ];
  for (const row of cmp.rows) {
    lines.push(`## ${row.label} - ${VERDICT_TEXT[row.verdict]}`, '', `\`${row.path}\``, '');
    lines.push(`- A: ${mask(sideLine(row.a))}`, `- B: ${mask(sideLine(row.b))}`);
    if (row.timeChangePct != null) lines.push(`- Time change: ${row.timeChangePct > 0 ? '+' : ''}${row.timeChangePct}%`);
    if (row.fields.length) {
      lines.push('- Response fields that changed:');
      for (const f of row.fields) lines.push(`  - ${f.noise ? `(noise: ${f.cause}) ` : ''}\`${f.path}\`: ${mask(f.a ?? '(not present)')} → ${mask(f.b ?? '(not present)')}`);
    }
    if (row.sent.length) {
      lines.push('- Sent differently:');
      for (const f of row.sent) lines.push(`  - \`${f.path}\`: ${mask(f.a ?? '(not present)')} → ${mask(f.b ?? '(not present)')}`);
    }
    lines.push('', 'Full response body A:', '', '```', mask(row.a.response?.body ?? ''), '```', '', 'Full response body B:', '', '```', mask(row.b.response?.body ?? ''), '```', '');
  }
  if (cmp.variables.length) {
    lines.push('## Values captured', '', '| Variable | Saved by | A | B |', '| --- | --- | --- | --- |');
    for (const v of cmp.variables) lines.push(`| \`${v.name}\` | ${v.savedBy ?? ''} | ${mask(v.a ?? '(not set)')} | ${mask(v.b ?? '(not set)')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildHtmlCompareReport(cmp: RunComparison, cycleName: string, sides: CompareReportSides, secretNames: readonly string[], variables: Readonly<Record<string, string>>): string {
  const mask = (text: string) => escapeHtml(maskRelive(text, secretNames, variables));
  const fieldList = (title: string, fields: RunComparison['rows'][number]['fields']) => fields.length
    ? `<p>${title}</p><ul>${fields.map((f) => `<li>${f.noise ? `(noise: ${escapeHtml(f.cause ?? '')}) ` : ''}<code>${escapeHtml(f.path)}</code>: ${mask(f.a ?? '(not present)')} → ${mask(f.b ?? '(not present)')}</li>`).join('')}</ul>`
    : '';
  const sections = cmp.rows.map((row) => `<section><h2>${escapeHtml(row.label)} - ${VERDICT_TEXT[row.verdict]}</h2>
    <p><code>${escapeHtml(row.path)}</code></p>
    <p>A: ${mask(sideLine(row.a))}<br>B: ${mask(sideLine(row.b))}${row.timeChangePct != null ? `<br>Time change: ${row.timeChangePct > 0 ? '+' : ''}${row.timeChangePct}%` : ''}</p>
    ${fieldList('Response fields that changed:', row.fields)}
    ${fieldList('Sent differently:', row.sent)}
    <p>Full response body A:</p><pre>${mask(row.a.response?.body ?? '')}</pre>
    <p>Full response body B:</p><pre>${mask(row.b.response?.body ?? '')}</pre></section>`).join('\n');
  const vars = cmp.variables.length
    ? `<h2>Values captured</h2><table><tr><th>Variable</th><th>Saved by</th><th>A</th><th>B</th></tr>${cmp.variables.map((v) => `<tr><td><code>${escapeHtml(v.name)}</code></td><td>${escapeHtml(v.savedBy ?? '')}</td><td>${mask(v.a ?? '(not set)')}</td><td>${mask(v.b ?? '(not set)')}</td></tr>`).join('')}</table>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relive run comparison: ${escapeHtml(cycleName)}</title></head>
  <body><h1>Relive run comparison: ${escapeHtml(cycleName)}</h1><p>A: ${escapeHtml(sides.a)}<br>B: ${escapeHtml(sides.b)}</p>
  <p><b>${escapeHtml(cmp.verdict.lead)}</b> ${escapeHtml(cmp.verdict.text)}</p>${sections}${vars}</body></html>`;
}

/** Unmasked, like the run's own .json export: both step results in full, per step. */
export function buildJsonCompareReport(cmp: RunComparison, cycleName: string, sides: CompareReportSides): string {
  return JSON.stringify(
    {
      cycleName,
      a: sides.a,
      b: sides.b,
      verdict: `${cmp.verdict.lead} ${cmp.verdict.text}`,
      counts: cmp.counts,
      steps: cmp.rows.map((row) => ({
        stepKey: row.key,
        label: row.label,
        path: row.path,
        verdict: row.verdict,
        timeChangePct: row.timeChangePct,
        fields: row.fields,
        sent: row.sent,
        a: { outcome: row.a.outcome, status: row.a.status, durationMs: row.a.durationMs, mode: row.a.mode, request: row.a.request, response: row.a.response, result: row.a.result },
        b: { outcome: row.b.outcome, status: row.b.status, durationMs: row.b.durationMs, mode: row.b.mode, request: row.b.request, response: row.b.response, result: row.b.result },
      })),
      variables: cmp.variables,
    },
    null,
    2,
  );
}
