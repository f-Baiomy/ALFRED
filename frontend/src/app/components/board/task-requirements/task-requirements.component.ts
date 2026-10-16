import { Component, Injector, computed, inject, input, model, output, signal } from '@angular/core';
import { ChecklistFile, MARK_LABELS, Mark, Requirement as ItemRequirement, RequirementsView, VERDICT_LABELS } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { messageOf } from '../../../core/state/board-state.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { formatChecks, parseChecks } from '../../../shared/utils/evidence-syntax';
import {
  CallPill, GroupInfo, REQ_GROUPS, ReqGroup, Requirement, STATE_PILLS, TaskNote, callPill, groupOf,
} from '../../../shared/utils/task-view';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/** "all", every row not met ("open"), or one group. */
export type ReqFilter = 'all' | 'open' | ReqGroup;

interface Row {
  readonly r: Requirement;
  readonly group: ReqGroup;
  readonly key: string;
  /** The item's number in its own spec file (AC1…), for "ask Claude". */
  readonly ac: number;
  readonly calls: ItemRequirement | null;
  readonly pill: CallPill | null;
}

/**
 * The Task tab's Requirements (specs/024): every Acceptance item once, grouped by what it needs from the user - decide
 * Claude's suggestion, bug, missing, re-test, can't tell, not checked, met (folded) - with one Pass / Fail / Can't tell
 * control per row and a short pill for what the calls say (specs/018's verdict, reason on hover). A row opens to the
 * user's or Claude's evidence, Claude's suggestion (Accept / Dismiss), the calls' reason, its spec file, and the
 * evidence / checks editors and "ask Claude". It was the Acceptance checklist beside the requirements; it is one list now.
 */
@Component({
  selector: 'app-task-requirements',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    <div class="tv-filters" role="toolbar" aria-label="Show">
      @for (c of chips(); track c.key) {
        <button type="button" class="tv-f" [class.on]="filter() === c.key" [disabled]="!c.n && c.key !== 'all'" (click)="filter.set(c.key)">
          @if (c.dot) { <span [class]="'tv-d tv-g-' + c.key"></span> }{{ c.label }} {{ c.n }}</button>
      }
    </div>
    @for (g of groups(); track g.info.key) {
      @let shut = folded(g.info.key);
      <div class="tv-group" [class.shut]="shut">
        <button type="button" class="tv-gh" [attr.aria-expanded]="!shut" (click)="toggleGroup(g.info.key)">
          <span class="tv-car">▾</span>{{ g.info.title }} · {{ g.rows.length }} <span class="tv-hint">- {{ g.info.hint }}</span>
          <span class="tv-info" [title]="g.info.tip">ⓘ</span>
        </button>
        @if (!shut) {
          @for (row of g.rows; track row.key) {
            @let open = isOpen(row.key);
            <div class="tv-req" [class.open]="open">
              <div class="tv-rq" (click)="toggleRow(row.key)">
                <span [class]="'tv-st tv-g-' + row.group">{{ pills[row.group] }}</span>
                <span class="tv-t"><span class="tv-k">{{ row.r.label }}</span>{{ row.r.item.text }}</span>
                <span class="tv-meta">
                  @for (c of row.r.cards; track c.number) {
                    <button type="button" class="tv-cardref" [title]="c.title + ' (' + c.status + ')'" (click)="$event.stopPropagation(); cardOpened.emit({ project: c.project, number: c.number })">#{{ c.number }}</button>
                  }
                  @if (row.pill; as p) { <span [class]="'tv-calls ' + p.tone" [title]="p.tip">{{ p.text }}</span> }
                </span>
                @if (editable()) {
                  <span class="tv-seg" (click)="$event.stopPropagation()">
                    @for (m of marks; track m) {
                      <button type="button" [class]="'tv-m-' + m" [class.on]="row.r.item.mark?.mark === m" [title]="'Mark it ' + markLabels[m]"
                              (click)="mark(row, m)">{{ markLabels[m] }}</button>
                    }
                  </span>
                }
              </div>
              @if (open) {
                <div class="tv-more">
                  @if (row.r.item.suggestion; as sg) {
                    <div class="tv-sugg">
                      <div class="tv-sugg-h">✦ Claude suggests {{ markLabels[sg.mark] }}</div>
                      @if (sg.evidence) { <app-markdown-view [text]="sg.evidence" /> }
                      @if (editable()) {
                        <div class="tv-acts">
                          <button type="button" class="tv-btn tv-accept" (click)="accept(row)">Accept {{ markLabels[sg.mark] }}</button>
                          <button type="button" class="tv-btn" (click)="dismiss(row)">Dismiss</button>
                        </div>
                      }
                    </div>
                  }
                  <div class="tv-kv">
                    @if (row.r.item.mark?.evidence) {
                      <span class="tv-kl">You</span><app-markdown-view [text]="row.r.item.mark!.evidence" />
                    }
                    @if (row.calls; as c) {
                      <span class="tv-kl">Calls</span>
                      <span>{{ verdictLabels[c.verdict.verdict] }}{{ c.verdict.reason ? ' - ' + c.verdict.reason : '' }}
                        @if (c.evidence?.endpoint) { <span class="board-dim"> · {{ c.evidence!.endpoint }}</span> }
                        @if (c.verdict.verdict === 'NOT_EXERCISED' && c.evidence?.howTo) { <span class="board-dim"> · how: {{ c.evidence!.howTo }}</span> }
                      </span>
                    }
                    <span class="tv-kl">From</span>
                    <span class="board-dim">{{ row.r.fileName }} · AC{{ row.ac }}{{ row.r.byUser ? ' · marked by you' : '' }}
                      @if (row.r.item.mark; as mk) { · {{ when(mk.updatedAt) }} }</span>
                  </div>
                  @if (editingEvidence() === row.key) {
                    <app-mention-editor [value]="row.r.item.mark?.evidence ?? ''" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                                        [cancellable]="true" [allowEmpty]="true" [rows]="2" [draftKey]="'evidence:' + cycleId() + ':' + row.r.fileName + ':' + row.r.item.key"
                                        (submitted)="mark(row, row.r.item.mark?.mark ?? 'CANT_TELL', $event)" (cancelled)="editingEvidence.set(null)" />
                  }
                  @if (checksOpen() === row.key) {
                    <div class="board-evidence-editor">
                      <label>Endpoint <input type="text" [value]="draftEndpoint()" (input)="draftEndpoint.set(value($event))"
                                             placeholder="POST /odeysysadmin/Booking2/refunded-requests/search - or UI" /></label>
                      <label>Checks <small>one per line: shape · when · match · rows · status</small>
                        <textarea rows="4" [value]="draftChecks()" (input)="draftChecks.set(value($event))"
                                  placeholder="shape $.branch* list&#10;when $.branch* list>=2&#10;match $.payload branch* in $.branch*&#10;rows $.payload"></textarea></label>
                      <label>How to exercise it <input type="text" [value]="draftHowTo()" (input)="draftHowTo.set(value($event))" /></label>
                      @if (checksError()) { <div class="board-error">{{ checksError() }}</div> }
                      <span class="tv-acts">
                        <button type="button" class="tv-btn tv-accept" (click)="saveChecks(row)">Save</button>
                        @if (row.calls?.evidence) { <button type="button" class="board-link" (click)="deleteChecks(row)">delete</button> }
                        <button type="button" class="board-link" (click)="checksOpen.set(null)">cancel</button>
                      </span>
                    </div>
                  }
                  @if (editable()) {
                    <div class="tv-links">
                      <button type="button" class="board-link" (click)="editingEvidence.set(editingEvidence() === row.key ? null : row.key)">✎ your evidence</button>
                      <button type="button" class="board-link" title="The endpoint and checks Alfred judges this by" (click)="openChecks(row)">⚙ how the calls show it</button>
                      <button type="button" class="board-link" title="Ask Claude about this item in the cycle's chat" (click)="ask(row)">💬 ask Claude</button>
                    </div>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    }
    @if (!groups().length && reqs().length) {
      <div class="board-dim tv-empty">Nothing here with this filter. <button type="button" class="board-link" (click)="filter.set('all')">Show all</button></div>
    }
    @if (showNotes() && (notes().length || notInTask().length)) {
      <div class="tv-group tv-also" [class.shut]="folded('ALSO')">
        <button type="button" class="tv-gh" [attr.aria-expanded]="!folded('ALSO')" (click)="toggleGroup('ALSO')">
          <span class="tv-car">▾</span>Also found · {{ notes().length + notInTask().length }} <span class="tv-hint">- not tied to a requirement</span>
          <span class="tv-info" title="Claude's notes, and changes in the branch the task never asked for (scope creep, or a requirement nobody wrote down).">ⓘ</span>
        </button>
        @if (!folded('ALSO')) {
          @for (n of notes(); track n.card.id) {
            <div class="tv-note"><span [class]="'task-kind task-kind-' + n.tag">{{ n.tag }}</span><span>{{ n.title }}</span>
              <button type="button" class="tv-cardref" (click)="cardOpened.emit({ project: n.card.project, number: n.card.number })">#{{ n.card.number }}</button></div>
          }
          @for (n of notInTask(); track n.card.id) {
            <div class="tv-note"><span class="task-kind task-kind-EXTRA">NOT IN TASK</span><span>{{ n.title }}</span>
              <button type="button" class="tv-cardref" (click)="cardOpened.emit({ project: n.card.project, number: n.card.number })">#{{ n.card.number }}</button></div>
          }
        }
      </div>
    }
    @if (error()) { <div class="board-error">{{ error() }}</div> }`,
})
export class TaskRequirementsComponent {
  private readonly api = inject(BoardApiService);
  /** Resolved on click: the chat's state is only needed when the user asks. */
  private readonly injector = inject(Injector);

  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);
  readonly reqs = input.required<readonly Requirement[]>();
  readonly files = input<readonly ChecklistFile[]>([]);
  /** The requirement check's view (null on an Alfred without it). */
  readonly view = input<RequirementsView | null>(null);
  readonly notes = input<readonly TaskNote[]>([]);
  readonly notInTask = input<readonly TaskNote[]>([]);
  readonly filter = model<ReqFilter>('all');
  /** A write was saved: the host reloads. */
  readonly changed = output<void>();
  readonly cardOpened = output<{ project: string; number: number }>();

  readonly pills = STATE_PILLS;
  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly markLabels = MARK_LABELS;
  readonly verdictLabels = VERDICT_LABELS;

  /** Rows the user opened, by key; groups the user folded or opened (Met starts folded). */
  private readonly opened = signal<ReadonlySet<string>>(new Set());
  private readonly foldState = signal<Readonly<Record<string, boolean>>>({});
  readonly editingEvidence = signal<string | null>(null);
  readonly checksOpen = signal<string | null>(null);
  readonly draftEndpoint = signal('');
  readonly draftChecks = signal('');
  readonly draftHowTo = signal('');
  readonly checksError = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  private readonly byItem = computed(() => new Map((this.view()?.items ?? []).map((r) => [`${r.fileName}\n${r.itemKey}`, r])));

  readonly rows = computed<Row[]>(() => this.reqs().map((r) => {
    const calls = this.byItem().get(`${r.fileName}\n${r.item.key}`) ?? null;
    const items = this.files().find((f) => f.fileName === r.fileName)?.items ?? [];
    return { r, group: groupOf(r), key: `${r.fileName}\n${r.item.key}`, ac: items.findIndex((i) => i.key === r.item.key) + 1,
      calls, pill: callPill(calls?.verdict) };
  }));

  readonly chips = computed(() => {
    const n = (g: ReqGroup) => this.rows().filter((x) => x.group === g).length;
    const all = this.rows().length;
    const out: { key: ReqFilter; label: string; n: number; dot: boolean }[] = [
      { key: 'all', label: 'All', n: all, dot: false },
      { key: 'open', label: 'Open', n: all - n('MET'), dot: false },
    ];
    // REQ_GROUPS ends with Met, which always shows; the others only when they have rows
    for (const g of REQ_GROUPS) {
      if (g.key === 'MET' || n(g.key)) out.push({ key: g.key, label: g.key === 'DECIDE' ? 'Claude suggests' : g.title, n: n(g.key), dot: true });
    }
    return out;
  });

  readonly groups = computed(() => {
    const f = this.filter();
    const keep = (row: Row) => f === 'all' || (f === 'open' ? row.group !== 'MET' : row.group === f);
    return REQ_GROUPS.map((info: GroupInfo) => ({ info, rows: this.rows().filter((x) => x.group === info.key && keep(x)) }))
      .filter((g) => g.rows.length);
  });

  /** "Also found" shows with the whole list, not under one group's filter. */
  readonly showNotes = computed(() => this.filter() === 'all' || this.filter() === 'open');

  folded(key: string): boolean {
    // a filter on one group shows it open
    if (this.filter() !== 'all' && this.filter() !== 'open' && key !== 'ALSO') return false;
    return this.foldState()[key] ?? key === 'MET';
  }

  toggleGroup(key: string): void {
    this.foldState.update((s) => ({ ...s, [key]: !this.folded(key) }));
  }

  isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  toggleRow(key: string): void {
    this.opened.update((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Opens a row (from outside: a Needs-you item or a mention). */
  openRow(fileName: string, itemKey: string): void {
    this.opened.update((s) => new Set(s).add(`${fileName}\n${itemKey}`));
  }

  mark(row: Row, mark: Mark, evidence?: string): void {
    this.editingEvidence.set(null);
    this.api.mark(this.cycleId(), row.r.fileName, row.r.item.key, mark, evidence ?? row.r.item.mark?.evidence ?? '').subscribe({
      next: () => { this.error.set(null); this.changed.emit(); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  accept(row: Row): void {
    this.api.acceptSuggestion(this.cycleId(), row.r.fileName, row.r.item.key).subscribe({
      next: () => { this.error.set(null); this.changed.emit(); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  dismiss(row: Row): void {
    this.api.dismissSuggestion(this.cycleId(), row.r.fileName, row.r.item.key).subscribe({
      next: () => { this.error.set(null); this.changed.emit(); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** "Ask Claude" about an Acceptance item (specs/022 FR-020): the cycle chat opens with the item attached. */
  ask(row: Row): void {
    const text = row.r.item.text;
    const label = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    this.injector.get(ChatStateService).ask(this.project(), this.cycleId(),
      { type: 'spec', ref: `${this.cycleId()}/${row.r.fileName}#ac${row.ac}`, label: `AC${row.ac} ${label}` });
  }

  openChecks(row: Row): void {
    if (this.checksOpen() === row.key) { this.checksOpen.set(null); return; }
    const ev = row.calls?.evidence;
    this.draftEndpoint.set(ev?.endpoint ?? '');
    this.draftChecks.set(formatChecks(ev?.checks ?? []));
    this.draftHowTo.set(ev?.howTo ?? '');
    this.checksError.set(null);
    this.checksOpen.set(row.key);
  }

  saveChecks(row: Row): void {
    const { checks, error } = parseChecks(this.draftChecks());
    if (error) { this.checksError.set(error); return; }
    this.api.putEvidence(this.cycleId(), { fileName: row.r.fileName, itemKey: row.r.item.key, project: this.project(),
      endpoint: this.draftEndpoint().trim(), checks, howTo: this.draftHowTo().trim() }).subscribe({
      next: () => { this.checksOpen.set(null); this.changed.emit(); },
      error: (e) => this.checksError.set(messageOf(e)),
    });
  }

  deleteChecks(row: Row): void {
    this.api.deleteEvidence(this.cycleId(), row.r.fileName, row.r.item.key).subscribe({
      next: () => { this.checksOpen.set(null); this.changed.emit(); },
      error: (e) => this.checksError.set(messageOf(e)),
    });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
