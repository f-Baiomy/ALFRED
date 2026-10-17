import { FieldDiff } from '../../core/team/team.models';

/** One field that changed between Alfred's saved copy and the tracker, as shown in a sync diff or a history entry. */
export interface DiffLine {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'added' | 'removed' | 'changed';
}

/** Tracker text (often HTML) as one plain line: tags dropped, entities read, whitespace folded. Never cut. */
export function plainText(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** The diff as lines, the fields people look at first (state, title, assigned) on top; equal text after cleaning is dropped. */
export function diffLines(diff: readonly FieldDiff[] | null | undefined): DiffLine[] {
  const order = ['System.State', 'State', 'System.Title', 'Title', 'System.AssignedTo', 'Assigned'];
  const rank = (f: string) => {
    const i = order.findIndex((o) => o.toLowerCase() === f.toLowerCase());
    return i < 0 ? order.length : i;
  };
  return (diff ?? [])
    .map((d) => {
      const from = plainText(d.from);
      const to = plainText(d.to);
      const kind: DiffLine['kind'] = !from ? 'added' : !to ? 'removed' : 'changed';
      return { field: d.field, from, to, kind };
    })
    .filter((d) => d.from !== d.to)
    .sort((a, b) => rank(a.field) - rank(b.field) || a.field.localeCompare(b.field));
}

/** "State: Active → Resolved · Title changed · +2 more" - for a badge's title or a one-line summary. */
export function diffSummary(diff: readonly FieldDiff[] | null | undefined, max = 2): string {
  const lines = diffLines(diff);
  if (!lines.length) return '';
  const short = (d: DiffLine) => {
    const name = d.field.replace(/^System\./, '');
    if (d.from.length <= 24 && d.to.length <= 24) return `${name}: ${d.from || '-'} → ${d.to || '-'}`;
    return `${name} changed`;
  };
  const head = lines.slice(0, max).map(short).join(' · ');
  return lines.length > max ? `${head} · +${lines.length - max} more` : head;
}
