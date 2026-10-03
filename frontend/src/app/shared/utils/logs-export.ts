import { LogComment, LogLine } from '../../core/models/logs.model';
import { escapeHtml } from './html-builder';
import { REDACTED } from './redact';

export type LogsExportFormat = 'ndjson' | 'json' | 'md' | 'html';

export interface LogsExportOptions {
  readonly sourceName: string;
  readonly formatTime: (ms: number) => string;
  readonly comments: ReadonlyMap<string, readonly LogComment[]>;
  /** JSON keys hidden everywhere (ALFRED's "all"-scope body-key redactions). */
  readonly redactKeys: ReadonlySet<string>;
  /** Field paths marked sensitive in the structure (privacy MASK). */
  readonly redactPaths: ReadonlySet<string>;
}

export interface LogsExport {
  readonly text: string;
  readonly redacted: number;
  readonly mime: string;
  readonly extension: string;
}

/**
 * Selection export (FR-040): every selected line in full - never truncated or summarised
 * (constitution invariant) - with ALFRED's redaction rules applied first. HTML output escapes
 * every value, so a payload in a log line can never run in a reader's browser.
 */
export function buildLogsExport(lines: readonly LogLine[], format: LogsExportFormat, opts: LogsExportOptions): LogsExport {
  let redacted = 0;
  const prepared = lines.map((l) => {
    const r = redactRaw(l.raw, opts.redactKeys, opts.redactPaths);
    redacted += r.count;
    return { line: l, raw: r.text, parsed: r.parsed };
  });
  switch (format) {
    case 'ndjson':
      return { text: prepared.map((p) => p.raw ?? '').join('\n') + '\n', redacted, mime: 'application/x-ndjson', extension: 'ndjson' };
    case 'json':
      return {
        text: JSON.stringify(
          {
            source: opts.sourceName,
            lineCount: prepared.length,
            redactedValues: redacted,
            lines: prepared.map((p) => ({
              lineId: p.line.lineId,
              time: opts.formatTime(p.line.ts),
              level: p.line.level,
              raw: p.raw,
              comments: (opts.comments.get(p.line.lineId) ?? []).map((c) => ({ path: c.path, text: c.text, at: c.createdAt })),
            })),
          },
          null,
          2,
        ),
        redacted,
        mime: 'application/json',
        extension: 'json',
      };
    case 'md':
      return { text: markdown(prepared, opts, redacted), redacted, mime: 'text/markdown', extension: 'md' };
    case 'html':
      return { text: html(prepared, opts, redacted), redacted, mime: 'text/html', extension: 'html' };
  }
}

type Prepared = { line: LogLine; raw: string | null; parsed: unknown };

function pretty(p: Prepared): string {
  return p.parsed !== undefined ? JSON.stringify(p.parsed, null, 2) : p.raw ?? '(raw line unavailable)';
}

function markdown(items: readonly Prepared[], opts: LogsExportOptions, redacted: number): string {
  const out = [`# ${opts.sourceName} - ${items.length} log lines`, ''];
  if (redacted) out.push(`> ${redacted} values redacted.`, '');
  for (const p of items) {
    out.push(`## ${opts.formatTime(p.line.ts)} ${p.line.level ?? ''}`.trimEnd(), '');
    for (const c of opts.comments.get(p.line.lineId) ?? []) {
      out.push(`> 💬 ${c.path ? `\`${c.path}\`: ` : ''}${c.text}`);
    }
    // A fence longer than any backtick run inside the body, so a body can never close it early.
    const body = pretty(p);
    const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    out.push('', `${fence}json`, body, fence, '');
  }
  return out.join('\n');
}

function html(items: readonly Prepared[], opts: LogsExportOptions, redacted: number): string {
  const rows = items.map((p) => {
    const comments = (opts.comments.get(p.line.lineId) ?? [])
      .map((c) => `<li>${c.path ? `<code>${escapeHtml(c.path)}</code>: ` : ''}${escapeHtml(c.text)}</li>`).join('');
    return `<section><h2>${escapeHtml(opts.formatTime(p.line.ts))} ${escapeHtml(p.line.level ?? '')}</h2>`
      + (comments ? `<ul>${comments}</ul>` : '') + `<pre>${escapeHtml(pretty(p))}</pre></section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.sourceName)} - log lines</title>`
    + '<style>body{font:14px system-ui;margin:24px}pre{background:#f5f6f9;padding:12px;white-space:pre-wrap;word-break:break-all}</style>'
    + `</head><body><h1>${escapeHtml(opts.sourceName)} - ${items.length} log lines</h1>`
    + (redacted ? `<p>${redacted} values redacted.</p>` : '') + rows.join('') + '</body></html>';
}

/** Replaces values of redacted keys / sensitive paths in a raw JSON line; non-JSON lines pass through. */
export function redactRaw(raw: string | null, keys: ReadonlySet<string>, paths: ReadonlySet<string>): { text: string | null; parsed: unknown; count: number } {
  if (raw === null) return { text: null, parsed: undefined, count: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, parsed: undefined, count: 0 };
  }
  if (!keys.size && !paths.size) return { text: raw, parsed, count: 0 };
  let count = 0;
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, v.length === 1 ? path : path ? `${path}.${i}` : String(i)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (keys.has(k) || paths.has(p)) {
          out[k] = REDACTED;
          count++;
        } else {
          out[k] = walk(x, p);
        }
      }
      return out;
    }
    return v;
  };
  const result = walk(parsed, '');
  return count ? { text: JSON.stringify(result), parsed: result, count } : { text: raw, parsed, count: 0 };
}
