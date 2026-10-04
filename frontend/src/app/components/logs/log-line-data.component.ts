import { Component, ElementRef, Injector, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { LogsApiService } from '../../core/services/logs-api.service';
import { ProfilesApiService } from '../../core/services/profiles-api.service';
import { Profile } from '../../core/models/profile.model';
import { FieldDef, LogComment, LogLine, LogStructure } from '../../core/models/logs.model';
import { commentsInside, jsonLines, JsonLine } from '../../shared/utils/logs-json-lines';
import { highlightSegments } from '../../shared/utils/logs-query-parse';
import { copyToClipboard } from '../../shared/utils/clipboard';
import { buildPathTree, groupKeys, visibleRows } from '../../shared/utils/logs-field-tree';
import { detectValue, explainValue, FormatProblem } from '../../shared/utils/logs-value-format';
import { highlightTokens, tokenizeJsonText } from '../../shared/utils/json-tokenizer';
import { tokenizeXmlText } from '../../shared/utils/xml-tokenizer';
import { splitTokensIntoLines } from '../../shared/utils/line-tokenizer';
import { JsonTokensComponent } from '../../shared/components/json-tokens/json-tokens.component';
import { JsonTreeComponent } from '../json-tree/json-tree.component';
import { XmlTreeNodeComponent } from './xml-tree-node.component';

export type FieldActionKind = 'eq' | 'neq' | 'col' | 'ex';

export interface FieldAction {
  readonly kind: FieldActionKind;
  readonly label: string;
  readonly value: string | null;
}

const PROFILE_KEY = 'alfred.logs.profile';

/** How a line's Table view lists its fields: grouped by dotted path, or one flat list. */
export type FieldLayout = 'GROUPED' | 'FLAT';

/**
 * Per line, for the browser session: the layout chosen on that line and the groups folded on it. Kept
 * outside the component so a line keeps its choice across list refreshes, the drawer and re-opening.
 */
const LINE_LAYOUT = new Map<string, FieldLayout>();
const LINE_CLOSED = new Map<string, ReadonlySet<string>>();
const MAX_REMEMBERED = 2_000;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.size >= MAX_REMEMBERED && !map.has(key)) map.delete(map.keys().next().value as string);
    map.set(key, value);
}
const MASK = '•••';
/** Table values longer than this (characters or lines) show their first lines with Show all / Open. */
const LONG_VALUE_CHARS = 240;
const LONG_VALUE_LINES = 3;

interface TableRow {
  readonly path: string;
  readonly field: FieldDef | null;
  readonly value: string;
  readonly masked: boolean;
}

/**
 * One log line's full data, as Table or JSON (FR-020), with field-anchored comments (FR-042) and the
 * field actions filter for / filter out / toggle column / present (FR-030). Values are rendered with
 * text bindings only - never innerHTML (constitution I). Mock: `dataHtml()`, `tableHtml()`, `jsonLines()`,
 * `commentBlock()`.
 */
@Component({
  selector: 'app-log-line-data',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, JsonTokensComponent, JsonTreeComponent, XmlTreeNodeComponent],
  templateUrl: './log-line-data.component.html',
})
export class LogLineDataComponent {
  private readonly api = inject(LogsApiService);
  private readonly profilesApi = inject(ProfilesApiService);

  readonly sourceId = input.required<string>();
  readonly line = input.required<LogLine>();
  readonly structure = input.required<LogStructure>();
  readonly comments = input<readonly LogComment[]>([]);
  readonly view = input<'TABLE' | 'JSON'>('TABLE');
  readonly terms = input<readonly string[]>([]);
  readonly columns = input<readonly string[]>([]);
  /** Privacy MASK: sensitive values hidden until revealed in this view. */
  readonly mask = input(false);
  readonly levelIds = input('');
  readonly showHeader = input(true);
  /** The source's default for lines not switched yet (structure setting). */
  readonly defaultLayout = input<FieldLayout>('GROUPED');

  readonly viewChange = output<'TABLE' | 'JSON'>();
  readonly fieldAction = output<FieldAction>();
  readonly commentsChanged = output<void>();

  readonly folded = signal<ReadonlySet<string>>(new Set());
  readonly editing = signal<string | null>(null);
  readonly draft = signal('');
  readonly draftError = signal('');
  readonly revealed = signal(false);
  readonly copied = signal(false);
  /** Long values shown in full in the Table view (Show all); the rest show their first lines. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** A value opened in its own window (⤢ Open): the same text, with find, wrap and Copy. */
  readonly opened = signal<{ path: string; value: string } | null>(null);
  readonly openedFind = signal('');
  readonly openedWrap = signal(true);
  readonly openedCopied = signal(false);
  readonly openedLines = computed(() => (this.opened()?.value ?? '').split('\n'));
  /** JSON or XML found in the opened value, as the window opens (null = neither, or it does not parse). */
  readonly openedDetected = computed(() => {
    const o = this.opened();
    return o ? detectValue(o.value) : null;
  });
  /** Original (exactly as stored) · Formatted · Tree. */
  readonly openedMode = signal<'orig' | 'fmt' | 'tree'>('orig');
  /** The "JSON found - Format / Tree / Keep as is" bar, until one of them is picked. */
  readonly openedOffer = signal(true);
  /** "Check format": why the value is not shown as JSON or XML. */
  readonly openedProblem = signal<FormatProblem | null>(null);
  /** The Formatted view: indented, coloured like call bodies, one row per line, with find matches. */
  readonly openedFormatted = computed(() => {
    const d = this.openedDetected();
    if (!d) return null;
    const tokens = d.kind === 'json' ? tokenizeJsonText(d.pretty) : tokenizeXmlText(d.pretty);
    const h = highlightTokens(tokens, this.openedFind().trim());
    return { lines: splitTokensIntoLines(h.tokens), matches: h.matchCount };
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Find in the window: the matches on screen (any view) and the one shown now (-1 = none). */
  readonly openedTotal = signal(0);
  readonly openedCur = signal(-1);
  readonly openedHits = computed(() => {
    const q = this.openedFind().trim().toLowerCase();
    if (!q) return 0;
    if (this.openedMode() === 'fmt') return this.openedFormatted()?.matches ?? 0;
    let n = 0;
    for (const l of this.openedLines()) {
      const low = l.toLowerCase();
      for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) n++;
    }
    return n;
  });
  readonly profiles = signal<Profile[]>([]);
  readonly profileId = signal<string | null>(readProfile());
  /** Bumped when this line's remembered layout / folded groups change (they live in module maps). */
  private readonly memo = signal(0);
  private readonly lineKey = computed(() => `${this.sourceId()}|${this.line().lineId}`);
  readonly layout = computed<FieldLayout>(() => {
    this.memo();
    return LINE_LAYOUT.get(this.lineKey()) ?? this.defaultLayout();
  });
  private readonly closed = computed<ReadonlySet<string>>(() => {
    this.memo();
    // Payloads (request/response bodies) can hold hundreds of leaves: they start folded.
    return LINE_CLOSED.get(this.lineKey()) ?? this.payloads();
  });
  /** The Table rows as a tree (groups start open; folding is remembered per line). */
  readonly tree = computed(() => buildPathTree(this.tableRows(), (r) => r.path));
  readonly treeRows = computed(() => {
    const closed = this.closed();
    return visibleRows(this.tree(), (k) => !closed.has(k));
  });

  private readonly sensitive = computed(() => new Set(this.structure().fields.filter((f) => f.sensitive).map((f) => f.path)));
  private readonly payloads = computed<ReadonlySet<string>>(() => new Set(this.structure().payloadPaths ?? []));
  private readonly byPath = computed(() => new Map(this.structure().fields.map((f) => [f.path, f])));
  readonly hidden = computed(() => this.mask() && !this.revealed() && this.sensitive().size > 0);

  readonly parsed = computed<unknown>(() => {
    const raw = this.line().raw;
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  });

  readonly tableRows = computed<TableRow[]>(() => {
    const map = this.byPath();
    const out: TableRow[] = [];
    const flat = this.parsed() !== undefined ? flatten(this.parsed()) : this.fieldsByPath();
    for (const [path, v] of Object.entries(flat)) {
      const field = map.get(path) ?? null;
      const masked = this.hidden() && this.isSensitive(path);
      out.push({ path, field, value: masked ? MASK : v === null ? 'null' : String(v), masked });
    }
    return out;
  });

  readonly lines = computed<JsonLine[]>(() => {
    const p = this.parsed();
    return p === undefined ? [] : jsonLines(this.hidden() ? maskValue(p, this.sensitive()) : p, this.folded());
  });

  readonly commentPaths = computed(() => this.comments().map((c) => c.path));
  readonly profileName = computed(() => new Map(this.profiles().map((p) => [p.id, `${p.avatar ?? '👤'} ${p.name}`])));

  constructor() {
    this.profilesApi.list().subscribe({ next: (p) => this.profiles.set(p), error: () => this.profiles.set([]) });
  }

  private fieldsByPath(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fields = this.line().fields;
    for (const f of this.structure().fields) if (f.label in fields) out[f.path] = fields[f.label];
    return out;
  }

  private isSensitive(path: string): boolean {
    for (const s of this.sensitive()) if (path === s || path.startsWith(`${s}.`)) return true;
    return false;
  }

  segments(text: string) {
    return highlightSegments(text, this.terms());
  }

  commentsAt(path: string): LogComment[] {
    return this.comments().filter((c) => c.path === path);
  }

  inside(line: JsonLine): number {
    return line.folded && line.path !== null ? commentsInside(line.path, this.commentPaths()) : 0;
  }

  author(c: LogComment): string {
    if (!c.authorProfileId) return 'Someone';
    return this.profileName().get(c.authorProfileId) ?? 'deleted profile';
  }

  setLayout(layout: FieldLayout): void {
    remember(LINE_LAYOUT, this.lineKey(), layout);
    this.memo.update((n) => n + 1);
  }

  isGroupOpen(key: string): boolean {
    return !this.closed().has(key);
  }

  toggleGroup(key: string): void {
    const next = new Set(this.closed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.setClosed(next);
  }

  expandAll(): void {
    this.setClosed(new Set());
  }

  collapseAll(): void {
    this.setClosed(new Set(groupKeys(this.tree())));
  }

  private setClosed(next: ReadonlySet<string>): void {
    remember(LINE_CLOSED, this.lineKey(), next);
    this.memo.update((n) => n + 1);
  }

  isPayload(path: string): boolean {
    return this.payloads().has(path);
  }

  /** Comments on fields inside a group - shown on the group row when it is folded. */
  commentsUnder(key: string): number {
    return this.comments().filter((c) => c.path.startsWith(`${key}.`)).length;
  }

  toggleFold(key: string): void {
    const next = new Set(this.folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.folded.set(next);
  }

  startComment(path: string): void {
    this.editing.set(path);
    this.draft.set('');
    this.draftError.set('');
  }

  saveComment(): void {
    const path = this.editing();
    const text = this.draft().trim();
    if (path === null) return;
    if (!text) {
      this.draftError.set('Write something first');
      return;
    }
    const pid = this.profileId();
    if (pid) writeProfile(pid);
    this.api.addComment(this.sourceId(), this.line().lineId, path, text, pid).subscribe({
      next: () => {
        this.editing.set(null);
        this.commentsChanged.emit();
      },
      error: (e) => this.draftError.set((e as { error?: { error?: string } })?.error?.error || 'Could not save the comment'),
    });
  }

  deleteComment(c: LogComment): void {
    this.api.deleteComment(this.sourceId(), c.id).subscribe(() => this.commentsChanged.emit());
  }

  act(kind: FieldActionKind, row: TableRow): void {
    if (!row.field) return;
    this.fieldAction.emit({ kind, label: row.field.label, value: row.masked ? null : row.value });
  }

  /**
   * A value long enough to collapse: more than LONG_VALUE_CHARS characters or LONG_VALUE_LINES lines.
   * It shows its first lines (faded); nothing about the text itself changes.
   */
  isLong(value: string): boolean {
    return value.length > LONG_VALUE_CHARS || value.split('\n', LONG_VALUE_LINES + 1).length > LONG_VALUE_LINES;
  }

  isExpanded(path: string): boolean {
    return this.expanded().has(path);
  }

  toggleExpanded(path: string): void {
    const next = new Set(this.expanded());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.expanded.set(next);
  }

  openValue(path: string, value: string): void {
    this.openedFind.set('');
    this.openedCopied.set(false);
    this.openedMode.set('orig');
    this.openedOffer.set(true);
    this.openedProblem.set(null);
    this.openedTotal.set(0);
    this.openedCur.set(-1);
    this.opened.set({ path, value });
  }

  setOpenedMode(mode: 'orig' | 'fmt' | 'tree'): void {
    this.openedMode.set(mode);
    this.openedOffer.set(false);
    this.findMatches();
  }

  /** The find text changed: highlight every match and go to the first. */
  setOpenedFind(text: string): void {
    this.openedFind.set(text);
    this.findMatches();
  }

  /**
   * After the view re-renders with its highlights, counts them and goes to the first. Works the same in
   * every view because each marks its matches with <mark> (the formatted view and the trees through the
   * call panels' own token / tree components).
   */
  private findMatches(): void {
    afterNextRender(() => {
      const marks = this.marks();
      this.openedTotal.set(marks.length);
      this.openedCur.set(-1);
      if (marks.length && this.openedFind().trim()) this.goToMatch(0);
    }, { injector: this.injector });
  }

  private marks(): HTMLElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.lg-vbody mark'));
  }

  /** Next / previous match (wrapping); Enter and Shift+Enter in the find box, or the ▲ ▼ buttons. */
  stepMatch(step: number): void {
    const n = this.marks().length;
    if (!n) return;
    this.goToMatch((Math.max(this.openedCur(), step > 0 ? -1 : 0) + step + n) % n);
  }

  /** Shows match `i`: opens the tree nodes around it, scrolls it to the middle and marks it as the current one. */
  private goToMatch(i: number): void {
    const marks = this.marks();
    const el = marks[i];
    if (!el) return;
    marks.forEach((m) => m.classList.remove('lg-cur'));
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
    el.classList.add('lg-cur');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    this.openedCur.set(i);
  }

  onFindKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    this.stepMatch(ev.shiftKey ? -1 : 1);
  }

  checkFormat(): void {
    const o = this.opened();
    if (o) this.openedProblem.set(explainValue(o.value));
  }

  /** Expand all / Collapse all in the Tree view (JSON and XML trees are both <details> nodes). */
  setTreeOpen(open: boolean): void {
    this.host.nativeElement.querySelectorAll<HTMLDetailsElement>('.lg-vbody details').forEach((d, i) => {
      // The root stays open on Collapse all, so the first level is still visible.
      d.open = open || i === 0;
    });
  }

  /** Find-in-value highlights: the window's own search, not the query bar's terms. */
  openedSegments(text: string) {
    const q = this.openedFind().trim();
    return highlightSegments(text, q ? [q] : []);
  }

  async copyOpened(): Promise<void> {
    const v = this.opened();
    if (!v) return;
    // What you see: the stored text, or the indented one in Formatted / Tree.
    const d = this.openedDetected();
    await copyToClipboard(this.openedMode() !== 'orig' && d ? d.pretty : v.value);
    this.openedCopied.set(true);
    setTimeout(() => this.openedCopied.set(false), 1500);
  }

  async copy(): Promise<void> {
    const raw = this.line().raw;
    if (raw === null) return;
    await copyToClipboard(this.hidden() ? JSON.stringify(maskValue(this.parsed(), this.sensitive())) : raw);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  isColumn(label: string): boolean {
    return this.columns().includes(label);
  }

  typeIcon(f: FieldDef | null): string {
    return f ? ({ DATETIME: '◷', DATE: '▦', NUMBER: '#', STRING: 't', BOOLEAN: 'b' } as const)[f.type] : '·';
  }
}

function readProfile(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function writeProfile(id: string): void {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // Remembering the author is a convenience; private windows simply ask again.
  }
}

/** Same path rules as logs-json-lines / the backend Flattener, for the Table view. */
function flatten(v: unknown, path = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(v) && v.length === 1) return flatten(v[0], path, out);
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object);
    if (!entries.length && path) out[path] = Array.isArray(v) ? '[]' : '{}';
    for (const [k, x] of entries) flatten(x, path ? `${path}.${k}` : k, out);
    return out;
  }
  out[path] = v;
  return out;
}

function maskValue(v: unknown, sensitive: ReadonlySet<string>, path = ''): unknown {
  if (sensitive.has(path) && path) return MASK;
  if (Array.isArray(v)) return v.map((x, i) => maskValue(x, sensitive, v.length === 1 ? path : path ? `${path}.${i}` : String(i)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) out[k] = maskValue(x, sensitive, path ? `${path}.${k}` : k);
    return out;
  }
  return v;
}
