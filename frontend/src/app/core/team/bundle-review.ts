import { WriteBundle, WriteStep } from './team.models';

/** One line of a step's review: a field (or the parent, state, tags) with its value before and after. */
export interface ReviewRow {
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
}

/** "Microsoft.VSTS.Scheduling.OriginalEstimate" -> "OriginalEstimate". */
export function fieldLabel(ref: string): string {
  return ref.slice(ref.lastIndexOf('.') + 1);
}

function json(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function links(text: string | undefined): { kind: string; id: string }[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((l) => l && l.kind && l.id) : [];
  } catch {
    return [];
  }
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/**
 * Whether a FIELD step edits several things at once (specs/038 FR-4) - else it is the one field of specs/030, shown as
 * before.
 */
export function isEdit(s: WriteStep): boolean {
  return s.kind === 'FIELD' && ['fields', 'parent', 'addLinks', 'removeLinks', 'addTags', 'removeTags', 'state'].some((k) => k in s.payload);
}

/** What a new item will hold, every value the user approves (specs/038 FR-1). */
export function createRows(s: WriteStep): ReviewRow[] {
  const p = s.payload;
  const out: ReviewRow[] = [];
  const add = (label: string, v: string | undefined) => { if (v) out.push({ label, before: null, after: v }); };
  add('Parent', p['parent'] === '' ? '(none)' : p['parent'] ? 'AB#' + p['parent'] : undefined);
  add('Assigned to', p['assignee']);
  add('Area', p['area']);
  add('Iteration', p['iteration']);
  add('Azure project', p['project']);
  for (const [k, v] of Object.entries(json(p['fields']))) add(fieldLabel(k), str(v) || '(empty)');
  add('Tags', p['tags']?.split(';').filter(Boolean).join(', '));
  for (const l of links(p['links'])) add(l.kind, 'AB#' + l.id);
  add('Copied from', p['copyOf'] ? 'AB#' + p['copyOf'] : undefined);
  add('Template', p['template']);
  return out;
}

/**
 * Every change of an edit step, old -> new: each field (its value when drafted, or Azure's now when the review read it),
 * the state, the parent, links and tags.
 */
export function editRows(s: WriteStep, nowJson?: string | null): ReviewRow[] {
  const p = s.payload;
  const from = json(nowJson ?? p['fromFields']);
  const out: ReviewRow[] = [];
  for (const [k, v] of Object.entries(json(p['fields']))) {
    out.push({ label: fieldLabel(k), before: k in from ? str(from[k]) || '(empty)' : null, after: str(v) || '(cleared)' });
  }
  if (p['state']) out.push({ label: 'State', before: p['fromState'] ?? null, after: p['state'] });
  if ('parent' in p) {
    out.push({ label: 'Parent', before: p['fromParent'] === undefined ? null : p['fromParent'] ? 'AB#' + p['fromParent'] : '(none)',
      after: p['parent'] ? 'AB#' + p['parent'] : '(none)' });
  }
  const tagsAdd = (p['addTags'] ?? '').split(';').filter(Boolean);
  const tagsRemove = (p['removeTags'] ?? '').split(';').filter(Boolean);
  if (tagsAdd.length || tagsRemove.length) {
    out.push({ label: 'Tags', before: p['fromTags'] ?? null,
      after: [...tagsAdd.map((t) => '+' + t), ...tagsRemove.map((t) => '−' + t)].join(' ') });
  }
  for (const l of links(p['addLinks'])) out.push({ label: '+ ' + l.kind, before: null, after: 'AB#' + l.id });
  for (const l of links(p['removeLinks'])) out.push({ label: '− ' + l.kind, before: 'AB#' + l.id, after: '(removed)' });
  return out;
}

/** What Azure said when the step was drafted or approved (specs/038 G-1, G-2). */
export function azureCheck(s: WriteStep): { tone: 'ok' | 'bad' | 'dim'; text: string } | null {
  const c = s.payload['azureCheck'];
  if (!c) return null;
  if (c === 'ok') return { tone: 'ok', text: '✓ Azure accepts this' };
  if (c.startsWith('refused: ')) return { tone: 'bad', text: '⛔ Azure refuses this: ' + c.slice('refused: '.length) };
  return { tone: 'dim', text: c.charAt(0).toUpperCase() + c.slice(1) };
}

const CLOSED = /^(closed|removed|done|cut|completed|resolved|won'?t fix)$/i;

/**
 * Why a bundle deserves one more look before it goes (specs/038 G-9): more than 5 items, an item moved to a closed state,
 * a re-parent, or an item assigned to someone else. Empty: Approve sends after its Undo, as always.
 */
export function wideReasons(w: Pick<WriteBundle, 'item'>, steps: readonly WriteStep[], me?: string | null): string[] {
  const on = steps.filter((s) => s.ticked);
  const out: string[] = [];
  const items = new Set(on.map((s, i) => (s.kind === 'CREATE' ? 'new-' + i : s.payload['item'] || w.item || '')));
  if (items.size > 5) out.push(`it changes ${items.size} work items`);
  const closing = on.filter((s) => (s.kind === 'STATE' || s.kind === 'FIELD') && (CLOSED.test(s.payload['state'] ?? '') || s.payload['category']));
  if (closing.length) out.push(`it closes ${closing.length === 1 ? 'an item' : closing.length + ' items'} (${closing.map((s) => s.payload['state'] || s.payload['category']).join(', ')})`);
  if (on.some((s) => s.kind === 'FIELD' && 'parent' in s.payload)) out.push('it moves an item under another parent');
  const mine = (me ?? '').toLowerCase();
  const others = on.flatMap((s) => {
    const to = s.kind === 'CREATE' ? s.payload['assignee'] : str(json(s.payload['fields'])['System.AssignedTo']) || (s.payload['field'] === 'System.AssignedTo' ? s.payload['value'] : '');
    return to && (!mine || !to.toLowerCase().includes(mine)) ? [to] : [];
  });
  if (others.length) out.push(`it assigns work to ${[...new Set(others)].join(', ')}`);
  return out;
}
