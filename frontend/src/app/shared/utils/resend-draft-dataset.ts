/**
 * D3 data-driven runs: turning pasted/uploaded text into a Dataset's rows. CSV (with a header row)
 * or a JSON array of flat objects, parsed client-side - whichever the text looks like. Values are
 * always strings, since a row only ever feeds `{{row.col}}` text substitution.
 */

import { Dataset } from './resend-draft';

const MAX_ROWS = 5000;

export interface ParsedDataset {
  readonly rows: readonly Record<string, string>[];
  readonly error: string | null;
}

export function parseDatasetText(text: string): ParsedDataset {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], error: null };
  return trimmed.startsWith('[') || trimmed.startsWith('{') ? parseJsonRows(trimmed) : parseCsvRows(trimmed);
}

function parseJsonRows(text: string): ParsedDataset {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], error: 'Could not parse as JSON.' };
  }
  if (!Array.isArray(data)) return { rows: [], error: 'Expected a JSON array of objects.' };
  return { rows: data.slice(0, MAX_ROWS).map(stringifyRow), error: null };
}

function stringifyRow(row: unknown): Record<string, string> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

function parseCsvRows(text: string): ParsedDataset {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return { rows: [], error: null };
  const header = lines[0];
  const rows = lines.slice(1, MAX_ROWS + 1).map((line) => {
    const row: Record<string, string> = {};
    header.forEach((name, i) => (row[name] = line[i] ?? ''));
    return row;
  });
  return { rows, error: null };
}

/** A minimal CSV reader: comma-separated, double-quoted fields with "" escaping, \r\n or \n lines. */
function splitCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // skip - \n follows
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function datasetPreview(dataset: Dataset, count = 3): readonly Record<string, string>[] {
  return dataset.rows.slice(0, count);
}
