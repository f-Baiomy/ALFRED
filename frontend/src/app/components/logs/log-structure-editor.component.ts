import { Component, HostListener, computed, effect, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DataView, FieldDef, FieldType, GroupLevel, GroupSort, LogStructure, PrivacyMode, Role, SearchMode } from '../../core/models/logs.model';
import { renderTemplate, templateTokens } from '../../shared/utils/logs-template';
import { buildFieldTree, FieldTreeNode, fieldsUnder, groupKeys, visibleRows } from '../../shared/utils/logs-field-tree';

/** Which part of the editor to show: the structure page has a tab per part, the load wizard shows all. */
export type StructureSection = 'all' | 'fields' | 'levels' | 'template';

const OPEN_KEY = 'alfred.logs.openFieldGroups.';

const ZONES = ['UTC', 'Asia/Dubai', 'Africa/Cairo', 'Asia/Riyadh', 'Europe/London', 'Europe/Istanbul', 'Asia/Karachi', 'America/New_York'];

/**
 * The structure editor (FR-010..016, FR-043/044/048; mock.html `wizStructure()`, `matchCell()`):
 * per-field type / format / search mode / role / sensitive, grouping levels, summary template with
 * a live preview, time zone, personal-data mode and default data view. Used as wizard step 2 and
 * on /logs/:id/structure; the parent saves.
 */
/** Gives `path` the role `role` (last in that role's order) and renumbers the role it left. */
export function withRole(fields: readonly FieldDef[], path: string, role: Role | null): FieldDef[] {
  const field = fields.find((x) => x.path === path);
  if (!field) return [...fields];
  const rank = role ? fields.filter((x) => x.path !== path && x.role === role).length + 1 : 0;
  let out = fields.map((x) => (x.path === path ? { ...x, role, roleRank: rank } : x));
  const left = field.role;
  if (left && left !== role) {
    const order = out.filter((x) => x.role === left).sort((a, b) => a.roleRank - b.roleRank || a.index - b.index);
    out = out.map((x) => (x.role === left ? { ...x, roleRank: order.indexOf(x) + 1 } : x));
  }
  return out;
}

@Component({
  selector: 'app-log-structure-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './log-structure-editor.component.html',
})
export class LogStructureEditorComponent {
  readonly structure = model.required<LogStructure>();
  readonly privacy = model<PrivacyMode>('SHOW');
  /** The wizard shows the personal-data choice; an existing source's privacy mode is fixed at creation. */
  readonly showPrivacy = input(false);
  readonly rebuilding = input<string>('');
  /** Values of one real line for the template preview. */
  readonly sample = input<Readonly<Record<string, unknown>>>({});
  /** Field label -> share of all lines that have it (an existing source; lines may differ in structure). */
  readonly presence = input<Readonly<Record<string, number>> | null>(null);
  readonly invalidClicked = output<string>();
  readonly section = input<StructureSection>('all');
  /** Remembers which field groups are open, per source (browser only; empty = not remembered). */
  readonly sourceId = input('');

  readonly filter = signal('');
  readonly showPrefix = signal(true);
  readonly detailFor = signal<string | null>(null);
  readonly menuFor = signal<string | null>(null);
  private readonly open = signal<ReadonlySet<string>>(new Set());
  private loadedOpenFor: string | null = null;

  readonly tree = computed(() => buildFieldTree(this.storedFields()));
  readonly rows = computed(() => visibleRows(this.tree(), this.open(), this.filter(), (f) => f.label));

  constructor() {
    effect(
      () => {
        const id = this.sourceId();
        const tops = this.tree().filter((n) => n.kind === 'group').map((n) => n.key);
        if (this.loadedOpenFor === id) return;
        this.loadedOpenFor = id;
        let saved: string[] | null = null;
        try {
          saved = id ? JSON.parse(localStorage.getItem(OPEN_KEY + id) ?? 'null') : null;
        } catch {
          saved = null;
        }
        // First visit: only the top-level groups open, so a big structure starts readable.
        this.open.set(new Set(Array.isArray(saved) ? saved : tops));
      },
      { allowSignalWrites: true },
    );
  }

  show(part: Exclude<StructureSection, 'all'>): boolean {
    return this.section() === 'all' || this.section() === part;
  }

  isOpen(key: string): boolean {
    return this.open().has(key);
  }

  private setOpen(next: Set<string>): void {
    this.open.set(next);
    const id = this.sourceId();
    if (!id) return;
    try {
      localStorage.setItem(OPEN_KEY + id, JSON.stringify([...next]));
    } catch {
      // Remembering open groups is a convenience; without storage they simply start closed.
    }
  }

  toggleGroup(key: string): void {
    if (this.filter()) return; // while filtering every match is shown open
    const next = new Set(this.open());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.setOpen(next);
  }

  expandAll(): void {
    this.setOpen(new Set(groupKeys(this.tree())));
  }

  collapseAll(): void {
    this.setOpen(new Set());
  }

  toggleDetail(path: string): void {
    this.detailFor.update((d) => (d === path ? null : path));
  }

  @HostListener('document:click')
  closeMenu(): void {
    this.menuFor.set(null);
  }

  toggleMenu(key: string): void {
    this.menuFor.update((m) => (m === key ? null : key));
  }

  /** One search mode for every field of a group (e.g. a big payload: Not searched). */
  groupSearch(node: FieldTreeNode, searchMode: SearchMode): void {
    const paths = new Set(fieldsUnder(node).map((f) => f.path));
    this.structure.update((s) => ({ ...s, fields: s.fields.map((f) => (paths.has(f.path) ? { ...f, searchMode } : f)) }));
    this.menuFor.set(null);
  }

  groupSensitive(node: FieldTreeNode, sensitive: boolean): void {
    const paths = new Set(fieldsUnder(node).map((f) => f.path));
    this.structure.update((s) => ({ ...s, fields: s.fields.map((f) => (paths.has(f.path) ? { ...f, sensitive } : f)) }));
    this.menuFor.set(null);
  }

  readonly types: FieldType[] = ['DATETIME', 'DATE', 'NUMBER', 'STRING', 'BOOLEAN'];
  readonly roles: (Role | '')[] = ['', 'TIME', 'LEVEL', 'CORRELATION', 'MESSAGE', 'SERVICE', 'DURATION', 'STATUS', 'REQUEST_BODY', 'RESPONSE_BODY', 'ERROR'];
  readonly sorts: GroupSort[] = ['TIME_ASC', 'TIME_DESC', 'ERRORS_DESC', 'LINES_DESC', 'MAX_DURATION_DESC', 'ID_ASC'];
  readonly zones = ZONES;

  readonly storedFields = computed(() => this.structure().fields.filter((f) => !f.duplicateOf));
  readonly duplicateCount = computed(() => this.structure().fields.length - this.storedFields().length);
  readonly overflowCount = computed(() => this.structure().overflowPaths?.length ?? 0);
  readonly payloads = computed(() => new Set(this.structure().payloadPaths ?? []));
  readonly overflowTitle = computed(() => (this.structure().overflowPaths ?? []).slice(0, 20).join('\n'));
  /** Fields per role: a role may sit on several fields (the same meaning under other names in other structures). */
  readonly roleCounts = computed(() => {
    const out: Partial<Record<Role, number>> = {};
    for (const f of this.storedFields()) if (f.role) out[f.role] = (out[f.role] ?? 0) + 1;
    return out;
  });
  readonly preview = computed(() => {
    const byLabel: Record<string, string | number | boolean | null> = {};
    const sample = this.sample();
    for (const f of this.structure().fields) {
      const v = sample[f.path] ?? f.sample;
      byLabel[f.label] = v === undefined ? null : (v as string | number | boolean | null);
    }
    return renderTemplate(this.structure().template, byLabel);
  });
  readonly unknownTokens = computed(() => {
    const labels = new Set(this.structure().fields.map((f) => f.label));
    return templateTokens(this.structure().template).filter((t) => !labels.has(t));
  });
  readonly zoneOptions = computed(() => (ZONES.includes(this.structure().timeZone) ? ZONES : [this.structure().timeZone, ...ZONES]));

  sortLabel(s: GroupSort): string {
    return ({ TIME_ASC: 'time ↑', TIME_DESC: 'time ↓', ERRORS_DESC: 'errors ↓', LINES_DESC: 'lines ↓', MAX_DURATION_DESC: 'max duration ↓', ID_ASC: 'id A→Z' } as const)[s];
  }

  roleLabel(r: Role | ''): string {
    return r === '' ? '—' : r.toLowerCase().replace('_', ' ');
  }

  searchLabel(s: SearchMode): string {
    return ({ EXACT: 'Exact', TEXT: 'Text', NONE: 'Not searched' } as const)[s];
  }

  matchText(f: FieldDef): string {
    return f.type === 'STRING' ? 'text' : `${(f.matchRate * 100).toFixed(f.matchRate === 1 ? 0 : 1)}%`;
  }

  private updateField(path: string, patch: Partial<FieldDef>): void {
    this.structure.update((s) => ({ ...s, fields: s.fields.map((f) => (f.path === path ? { ...f, ...patch } : f)) }));
  }

  presenceOf(f: FieldDef): number | null {
    const p = this.presence();
    return p ? (p[f.label] ?? 0) : null;
  }

  percent(v: number): string {
    return v >= 0.995 ? '100%' : v > 0 && v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`;
  }

  /** "1st", "2nd": the order a line tries the fields of one role. */
  ordinal(n: number): string {
    return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  }

  rankOptions(f: FieldDef): number[] {
    const n = f.role ? (this.roleCounts()[f.role] ?? 0) : 0;
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  setType(f: FieldDef, type: FieldType): void {
    const format = type === 'DATETIME' ? 'ISO-8601 · UTC' : type === 'DATE' ? 'yyyy-MM-dd · UTC' : type === 'BOOLEAN' ? 'true = true · false = false' : '';
    this.updateField(f.path, { type, format, typeSource: 'USER' });
  }

  makeBoolean(f: FieldDef): void {
    this.updateField(f.path, { type: 'BOOLEAN', format: '1 = true · 0 = false', typeSource: 'USER' });
  }

  setFormat(f: FieldDef, format: string): void {
    this.updateField(f.path, { format });
  }

  setSearch(f: FieldDef, searchMode: SearchMode): void {
    this.updateField(f.path, { searchMode });
  }

  /** A role can be on several fields; a field joining a role goes last, leaving one closes the gap. */
  setRole(f: FieldDef, role: Role | ''): void {
    this.structure.update((s) => ({ ...s, fields: withRole(s.fields, f.path, role === '' ? null : role) }));
  }

  /** Moves a field to position `rank` among its role's fields (swapping with the one there). */
  setRank(f: FieldDef, rank: number): void {
    this.structure.update((s) => ({
      ...s,
      fields: s.fields.map((x) =>
        x.path === f.path ? { ...x, roleRank: rank } : x.role === f.role && x.roleRank === rank ? { ...x, roleRank: f.roleRank } : x,
      ),
    }));
  }

  setSensitive(f: FieldDef, sensitive: boolean): void {
    this.updateField(f.path, { sensitive });
  }

  setTemplate(template: string): void {
    this.structure.update((s) => ({ ...s, template }));
  }

  setZone(timeZone: string): void {
    this.structure.update((s) => ({ ...s, timeZone }));
  }

  setDataView(defaultDataView: DataView): void {
    this.structure.update((s) => ({ ...s, defaultDataView }));
  }

  setFieldLayout(defaultFieldLayout: 'GROUPED' | 'FLAT'): void {
    this.structure.update((s) => ({ ...s, defaultFieldLayout }));
  }

  private setLevels(levels: GroupLevel[]): void {
    this.structure.update((s) => ({ ...s, groupLevels: levels }));
  }

  addLevel(): void {
    const used = new Set(this.structure().groupLevels.map((l) => l.fieldLabel));
    // Suggest the likeliest ID field first: the correlation role, then anything named like an id
    // (sessionId, inboundCallId, ...) - not "_index"/"_id", which are per-line, never shared.
    const rank = (f: FieldDef) => (f.role === 'CORRELATION' ? 0 : /[a-z]Id$/.test(f.label) ? 1 : 2);
    const next = this.storedFields()
      .filter((f) => !used.has(f.label) && f.type === 'STRING' && !f.label.startsWith('_'))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (next) this.setLevels([...this.structure().groupLevels, { fieldLabel: next.label, sort: 'TIME_ASC' }]);
  }

  levelField(i: number, fieldLabel: string): void {
    this.setLevels(this.structure().groupLevels.map((l, j) => (j === i ? { ...l, fieldLabel } : l)));
  }

  levelSort(i: number, sort: GroupSort): void {
    this.setLevels(this.structure().groupLevels.map((l, j) => (j === i ? { ...l, sort } : l)));
  }

  moveUp(i: number): void {
    if (i === 0) return;
    const l = [...this.structure().groupLevels];
    [l[i - 1], l[i]] = [l[i], l[i - 1]];
    this.setLevels(l);
  }

  removeLevel(i: number): void {
    this.setLevels(this.structure().groupLevels.filter((_, j) => j !== i));
  }

  isRebuilding(f: FieldDef): boolean {
    return this.rebuilding().split(',').includes(f.label);
  }
}
