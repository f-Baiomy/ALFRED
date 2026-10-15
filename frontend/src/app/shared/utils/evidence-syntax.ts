import { EvidenceCheck } from '../../core/models/board.models';

/**
 * An Acceptance item's evidence checks as short lines (specs/018), for the Task tab's editor - one check per line:
 *
 *   shape  $.branch* list          the request can carry a list (list | scalar | present)
 *   when   $.branch* list>=2       the call exercises the item (none | one | list | list>=2 | present)
 *   match  $.payload branch* in $.branch*   every row's branch is in the request's branches
 *   rows   $.payload [min]         the answer has rows (at least min)
 *   status 2xx                     the status is in range (2xx | 200 | !405 | !5xx)
 *
 * The backend validates the same rules; this only turns text into checks and back.
 */

const PATH = /^\$(\.[A-Za-z0-9_-]+|\[\d+\])*(\.[A-Za-z0-9_-]*\*)?$/;
const MUST = ['list', 'scalar', 'present'];
const WHEN = ['none', 'one', 'list', 'list>=2', 'present'];

export function formatCheck(c: EvidenceCheck): string {
  switch (c.kind) {
    case 'REQUEST_SHAPE': return `shape ${c.path} ${c.shape}`;
    case 'REQUEST_WHEN': return `when ${c.path} ${c.shape}`;
    case 'ROWS_MATCH_FILTER': return `match ${c.rows} ${c.field} in ${c.path}`;
    case 'ROWS_PRESENT': return `rows ${c.rows}${c.min && c.min > 1 ? ` ${c.min}` : ''}`;
    case 'STATUS': return `status ${c.range}`;
  }
}

export function formatChecks(checks: readonly EvidenceCheck[]): string {
  return checks.map(formatCheck).join('\n');
}

/** One line to a check, or why it is not one. */
export function parseCheck(line: string): EvidenceCheck | string {
  const w = line.trim().split(/\s+/);
  const word = (w[0] ?? '').toLowerCase();
  const bad = (why: string) => `"${line.trim()}": ${why}`;
  switch (word) {
    case 'shape':
    case 'when': {
      const shapes = word === 'shape' ? MUST : WHEN;
      if (w.length !== 3 || !PATH.test(w[1])) return bad(`${word} <request path> <${shapes.join(' | ')}>`);
      const shape = w[2].toLowerCase();
      if (!shapes.includes(shape)) return bad(`the shape is one of ${shapes.join(', ')}`);
      return { kind: word === 'shape' ? 'REQUEST_SHAPE' : 'REQUEST_WHEN', path: w[1], shape };
    }
    case 'match':
      if (w.length !== 5 || w[3].toLowerCase() !== 'in' || !PATH.test(w[1]) || w[1].includes('*') || !PATH.test(w[4])
        || !/^([A-Za-z0-9_-]+\*?|\*)$/.test(w[2])) return bad('match <response list> <row field> in <request path>');
      return { kind: 'ROWS_MATCH_FILTER', rows: w[1], field: w[2], path: w[4] };
    case 'rows': {
      if (w.length < 2 || w.length > 3 || !PATH.test(w[1]) || w[1].includes('*')) return bad('rows <response list> [min]');
      const min = w[2] === undefined ? null : Number(w[2]);
      if (min !== null && !(Number.isInteger(min) && min >= 1 && min <= 10_000)) return bad('min is a whole number from 1');
      return { kind: 'ROWS_PRESENT', rows: w[1], ...(min !== null ? { min } : {}) };
    }
    case 'status':
      if (w.length !== 2 || !/^!?([1-5]xx|[1-5]\d\d)$/i.test(w[1])) return bad('status <2xx | 200 | !405 | !5xx>');
      return { kind: 'STATUS', range: w[1].toLowerCase() };
    default:
      return bad('a line starts with shape, when, match, rows or status');
  }
}

/** Every non-empty line to a check; the first line that is not one is the error. */
export function parseChecks(text: string): { checks: EvidenceCheck[]; error: string | null } {
  const checks: EvidenceCheck[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = parseCheck(line);
    if (typeof c === 'string') return { checks, error: c };
    checks.push(c);
  }
  return { checks, error: null };
}
