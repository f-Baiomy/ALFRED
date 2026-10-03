import { FieldValue } from '../../core/models/logs.model';

/**
 * Renders a source's summary-line template (FR-014): `{label}` tokens filled from a line's fields,
 * segments separated by " · "; a segment whose tokens are all empty is dropped, so a line without
 * `{externalService}` does not end in a stray separator (mock `summary()`).
 */
export function renderTemplate(template: string, fields: Readonly<Record<string, FieldValue | undefined>>): string {
  return template
    .split(' · ')
    .map((segment) => {
      let anyValue = false;
      let anyToken = false;
      const text = segment.replace(/\{([^}]+)\}/g, (_, label: string) => {
        anyToken = true;
        const v = fields[label];
        if (v === undefined || v === null || v === '') return '';
        anyValue = true;
        return String(v);
      });
      return anyToken && !anyValue ? '' : text.trim();
    })
    .filter((s) => s.length > 0)
    .join(' · ');
}

/**
 * A line of another structure may have none of the template's fields: rather than an empty summary,
 * show what the line does have (up to `max` label=value pairs, `skip` excluded - e.g. time and level,
 * which the row already shows).
 */
export function summaryOrFields(
  template: string,
  fields: Readonly<Record<string, FieldValue | undefined>>,
  skip: ReadonlySet<string> = new Set(),
  max = 4,
): string {
  const text = renderTemplate(template, fields);
  if (text) return text;
  return Object.entries(fields)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null && v !== '')
    .slice(0, max)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

/** The labels a template reads - so a missing field can be flagged in the editor. */
export function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
