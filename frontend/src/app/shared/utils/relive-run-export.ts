/**
 * The run export (.md/.json/.html, T079) - follows the project's hard no-truncation rule for call
 * data, same as `scenario-run-export.ts`: a step's full actual response body is always included,
 * never summarized or clipped. Masking reuses `relive-mask.ts`'s `maskRelive` (the same secret
 * handling every other Relive view uses), not `redact.ts`'s global rules.
 */
import { maskRelive } from './relive-mask';
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
