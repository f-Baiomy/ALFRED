import { Component, DestroyRef, ElementRef, HostListener, QueryList, ViewChildren, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { auditTime, catchError, filter, forkJoin, map, of } from 'rxjs';
import { BoardSummary, CardSummary, ItemMark, NO_FILTERS } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardCycleRow, CardCycleVerdict, CycleSummary, TestedCard } from '../../../core/models/cycles-tab.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { CycleDeleteService } from '../../../core/services/cycle-delete.service';
import { CycleExportService } from '../../../core/services/cycle-export.service';
import { EditCycleDialogService } from '../../../core/services/edit-cycle-dialog.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import {
  Comparison, compareCycles, environmentOf, pauseSuggested, readyToRetest, retestName, verdictTone, verdictWord, versusLine,
} from '../../../shared/utils/cycle-tab';
import { CycleVerdictsDialogComponent } from '../cycle-verdicts-dialog/cycle-verdicts-dialog.component';
import { recordForBoard } from '../record-line/record-line.component';
import { CycleRowAction, CycleRowComponent } from './cycle-row.component';

type Chip = 'all' | 'recording' | 'retests' | 'failures';
type Sort = 'newest' | 'oldest' | 'failures' | 'calls';

/** Per-viewer conveniences only (a hidden suggestion): browser storage, every access guarded. */
function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set].slice(-500)));
  } catch {
    // private window: the choice lasts for this page only
  }
}

/**
 * A board's Cycles (specs/033, on specs/028 US7): one compact row per cycle (cycle-row), the ● Record split button
 * (record / re-test cards… / join), a quiet "ready to re-test" line, search and filters, selection with Compare /
 * Evidence pack / Ask Claude / Archive, and archived cycles out of the way. No polling: rows reload on the board and
 * session-cycle signals. Nothing opens unless clicked; every suggestion can be hidden for good.
 */
@Component({
  selector: 'app-board-cycles',
  standalone: true,
  imports: [CycleRowComponent, CycleVerdictsDialogComponent, CloseOnOutsideDirective],
  template: `
    <div class="cyx-tab">
      <div class="cyx-head">
        <div class="cyx-stats">
          <div><b>{{ visibleRows().length }}</b><span>cycles</span></div>
          <div><b>{{ totals().calls }}</b><span>calls</span></div>
          <div><b [class.cyx-bad]="totals().failed">{{ totals().failed }}</b><span>failed calls</span></div>
          @if (totals().acTotal) { <div><b>{{ totals().acMet }} / {{ totals().acTotal }}</b><span>requirements met</span></div> }
        </div>
        <span class="cyx-grow"></span>
        @if (editable()) {
          <div class="cyx-split" [appCloseOnOutside]="recMenu()" (closed)="recMenu.set(false)">
            <button type="button" class="action-btn primary" [disabled]="busy()" (click)="record()">● Record</button>
            <button type="button" class="action-btn primary" aria-label="More ways to record" [attr.aria-expanded]="recMenu()" (click)="recMenu.set(!recMenu())">▾</button>
            @if (recMenu()) {
              <div class="cyx-menu wide">
                <button type="button" (click)="record()">● Record a new cycle<small>Calls you make now are captured for this board</small></button>
                <button type="button" (click)="openRetest()">↻ Re-test cards…<small>Pick the fixed cards - the cycle is named after them</small></button>
              </div>
            }
          </div>
          <button type="button" class="action-btn" (click)="openAdd()">＋ Add existing cycle</button>
        }
      </div>
      @if (message()) {
        <div class="cyx-msg" [class.cyx-err]="isError()" role="status"><span [title]="message()">{{ message() }}</span>
          <button type="button" class="cyx-ghost" aria-label="Hide" (click)="message.set(null)">✕</button></div>
      }

      @if (editable() && ready().length) {
        <div class="cyx-nudge">
          <span>↻ @for (c of ready().slice(0, 4); track c.id) { <b>#{{ c.number }}</b> } {{ ready().length === 1 ? 'was' : 'were' }} fixed after the last re-test.</span>
          <button type="button" class="action-btn primary" (click)="openRetest(ready())">Re-test {{ ready().length === 1 ? 'it' : 'them' }}</button>
          <button type="button" class="cyx-ghost cyx-x" title="Hide until another card is fixed" aria-label="Hide" (click)="hideReady()">✕</button>
        </div>
      }

      <div class="cyx-toolbar">
        <input type="search" placeholder="Search cycles, endpoints…" [value]="q()" (input)="q.set($any($event.target).value)" aria-label="Search cycles" />
        @for (c of chips; track c.key) {
          <button type="button" class="cyx-chip" [class.on]="chip() === c.key" (click)="chip.set(c.key)">{{ c.label }}</button>
        }
        <span class="cyx-grow"></span>
        @if (envs().length > 1) {
          <select aria-label="Environment" [value]="env()" (change)="env.set($any($event.target).value)">
            <option value="">All environments</option>
            @for (e of envs(); track e) { <option [value]="e">{{ e }}</option> }
          </select>
        }
        <select aria-label="Sort" [value]="sort()" (change)="sort.set($any($event.target).value)">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
          <option value="failures">Most failures</option><option value="calls">Most calls</option>
        </select>
      </div>

      @if (selected().size) {
        <div class="cyx-bulk">
          <b>{{ selected().size }} selected</b>
          <button type="button" class="action-btn" [disabled]="selected().size !== 2" [title]="selected().size !== 2 ? 'Select two cycles to compare' : ''" (click)="compareSelected()">⇄ Compare</button>
          <button type="button" class="action-btn" (click)="openPack(selectedCycles())">📦 Evidence pack</button>
          <button type="button" class="action-btn" (click)="askAboutSelected()">✦ Ask Claude</button>
          @if (editable()) {
            <button type="button" class="action-btn" (click)="archiveSelected()">🗄 Archive</button>
            <button type="button" class="action-btn cyx-danger-btn" (click)="deleteSelected()">🗑 Delete</button>
          }
          <span class="cyx-grow"></span>
          <button type="button" class="cyx-ghost" (click)="selected.set(empty)">Clear</button>
        </div>
      }

      <div class="cyx-list" (keydown)="keys($event)">
        @for (v of shown(); track v.row.cycleId) {
          <app-cycle-row [cycle]="v.cycle" [row]="v.row" [summary]="summaries()[v.row.cycleId] ?? null" [marks]="marks()[v.row.cycleId] ?? null"
                         [found]="found()[v.row.cycleId] ?? []" [boardId]="boardId()" [editable]="editable()" [selected]="selected().has(v.row.cycleId)"
                         [env]="envOf(v.row.cycleId)" [versus]="versusOf(v.row.cycleId)" [hasBaseline]="!!baseline()" [claudeSummaries]="claudeSummaries()"
                         [pauseHint]="pauseHintOf(v.row, v.cycle)"
                         (selectedChange)="select(v.row.cycleId, $event)" (action)="onAction(v.cycle, v.row, $event)"
                         (cardTimeline)="showTimeline($event.card, $event.event)" (dismissPause)="hidePauseHint(v.row.cycleId)" (changed)="cycleChanged($event)" />
        } @empty {
          <div class="cyx-empty">@if (rows().length) { No cycle matches. } @else { No cycle yet - Record a cycle while you test the task. }</div>
        }
      </div>

      <div class="cyx-foot">
        @if (archivedRows().length) {
          <button type="button" class="cyx-link" (click)="showArchived.set(!showArchived())">{{ archivedRows().length }} archived</button><span>·</span>
        }
        <button type="button" class="cyx-link" (click)="keysOpen.set(true)">keyboard: ?</button>
        @if (!claudeSummaries() && editable()) { <span>·</span><button type="button" class="cyx-link" (click)="setSummaries(true)">Claude's cycle summaries are off - turn on</button> }
      </div>
      @if (showArchived()) {
        <div class="cyx-archived">
          @for (v of archivedRows(); track v.row.cycleId) {
            <div class="cyx-arow">🗄 {{ v.cycle.name }} <span class="cyx-grow"></span>{{ summaries()[v.row.cycleId]?.calls ?? '' }} calls
              @if (editable()) { <button type="button" class="action-btn" (click)="flag(v.row.cycleId, { archived: false })">Restore</button> }</div>
          }
        </div>
      }
    </div>

    @if (timeline(); as t) {
      <div class="cyx-pop" [style.top.px]="t.y" [style.left.px]="t.x" [appCloseOnOutside]="true" (closed)="timeline.set(null)" role="dialog" aria-label="Verdict timeline">
        <div class="cyx-pop-h"><b>#{{ t.card.number }} {{ t.card.title }}</b><span class="cyx-grow"></span>
          <button type="button" class="cyx-ghost" aria-label="Close" (click)="timeline.set(null)">✕</button></div>
        <div class="cyx-dim">{{ t.card.status.replace('_', ' ').toLowerCase() }} · every cycle that checked it, oldest first</div>
        @if (t.verdicts; as vs) {
          <div class="cyx-tl">
            @for (v of vs; track v.cycleId) {
              @if (!$first) { <span class="cyx-ln"></span> }
              <span class="cyx-p" [title]="v.name + (v.summary ? ' - ' + v.summary : '')">
                <b [class]="tone(v)">{{ tone(v) === 'ok' ? '✓' : tone(v) === 'bad' ? '✗' : '?' }}</b>{{ shortTime(v.cycleId) }}<span>{{ v.home ? 'found' : verdictWord(v.verdict) }}</span>
              </span>
            } @empty { <span class="cyx-dim">No cycle checked it yet.</span> }
          </div>
        } @else { <div class="cyx-dim">Loading…</div> }
        @if (editable()) { <button type="button" class="action-btn" (click)="openRetest([t.card]); timeline.set(null)">↻ Re-test it</button> }
      </div>
    }

    @if (retest(); as rt) {
      <div class="dialog-backdrop" (click)="retest.set(null)">
        <div class="dialog-card wide cyx-dlg" role="dialog" aria-label="Re-test cards" (click)="$event.stopPropagation()" (keydown.escape)="retest.set(null)">
          <h2>Re-test cards</h2>
          <p class="dialog-sub">The cycle is named after the cards it tests and linked to each - every card shows this re-test and its verdict.</p>
          <div class="cyx-pick">
            @for (c of retestChoices(); track c.id) {
              <label><input type="checkbox" [checked]="rt.cards.includes(c.number)" (change)="toggleRetestCard(c.number)" />
                <span>#{{ c.number }} {{ c.title }}<br /><small>{{ c.status.replace('_', ' ').toLowerCase() }}</small></span></label>
            } @empty { <div class="cyx-empty">No Fixed card on this board - a re-test can still record the whole task.</div> }
          </div>
          <label class="dialog-field">Name<input type="text" maxlength="160" [value]="rtName()" (input)="renameRetest($any($event.target).value)" /></label>
          <label class="dialog-field">Description<textarea rows="5" maxlength="20000" [value]="rt.description" (input)="describeRetest($any($event.target).value)"></textarea></label>
          <div class="dialog-hint">Steps as “- [ ] Search POST /api/search/flights” tick themselves when that call succeeds.</div>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="retest.set(null)">Cancel</button>
            <button type="button" class="dialog-btn primary" [disabled]="busy()" (click)="startRetest()">● Start re-test</button>
          </div>
        </div>
      </div>
    }

    @if (comparison(); as cmp) {
      <div class="dialog-backdrop" (click)="comparison.set(null)">
        <div class="dialog-card wide cyx-dlg" role="dialog" aria-label="Compare cycles" (click)="$event.stopPropagation()" (keydown.escape)="comparison.set(null)">
          <h2>Compare</h2>
          <div class="cyx-cmp">
            <div class="h"></div><div class="h">{{ cmp.aName }}</div><div class="h">{{ cmp.bName }}</div>
            <div class="g">Totals</div>
            @for (t of cmp.c.totals; track t.label) { <div>{{ t.label }}</div><div>{{ t.a }}</div><div [class.cyx-bad]="t.worse">{{ t.b }}{{ t.worse ? ' ▲' : '' }}</div> }
            @if (cmp.c.statusChanged.length || cmp.c.slower.length || cmp.c.onlyA.length || cmp.c.onlyB.length) {
              <div class="g">What changed</div>
              @for (s of cmp.c.statusChanged; track s.endpoint) { <div>{{ s.endpoint }}</div><div>{{ s.a ?? '—' }}</div><div [class.cyx-bad]="s.worse">{{ s.b ?? '—' }}</div> }
              @for (s of cmp.c.slower; track s.endpoint) { <div>Slower: {{ s.endpoint }}</div><div>{{ round(s.a) }} ms</div><div class="cyx-bad">{{ round(s.b) }} ms</div> }
              @for (e of cmp.c.onlyA; track e) { <div>Only before</div><div>{{ e }}</div><div>—</div> }
              @for (e of cmp.c.onlyB; track e) { <div>Only now</div><div>—</div><div>{{ e }}</div> }
            } @else { <div class="g">Same endpoints and statuses</div> }
          </div>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="askCompare(cmp.aId, cmp.bId)">✦ Ask Claude why</button>
            <button type="button" class="dialog-btn primary" (click)="comparison.set(null)">Close</button>
          </div>
        </div>
      </div>
    }

    @if (pack(); as p) {
      <div class="dialog-backdrop" (click)="pack.set(null)">
        <div class="dialog-card cyx-dlg" role="dialog" aria-label="Evidence pack" (click)="$event.stopPropagation()" (keydown.escape)="pack.set(null)">
          <h2>Evidence pack</h2>
          <p class="dialog-sub">{{ p.cycles.length === 1 ? 'The cycle' : p.cycles.length + ' cycles' }} with every call in full - nothing cut. One file per cycle.</p>
          <div class="cyx-pick">
            <label><input type="radio" name="cyx-fmt" [checked]="p.format === 'markdown'" (change)="packFormat('markdown')" /> .md <small>for a ticket or a person</small></label>
            <label><input type="radio" name="cyx-fmt" [checked]="p.format === 'json'" (change)="packFormat('json')" /> .json <small>re-importable into Alfred</small></label>
          </div>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="pack.set(null)">Cancel</button>
            <button type="button" class="dialog-btn primary" (click)="savePack()">Save</button>
          </div>
        </div>
      </div>
    }

    @if (adding()) {
      <div class="dialog-backdrop" (click)="adding.set(false)">
        <div class="dialog-card wide cyx-dlg" role="dialog" aria-label="Add an existing cycle" (click)="$event.stopPropagation()" (keydown.escape)="adding.set(false)">
          <h2>Add an existing cycle</h2>
          <input type="search" class="cyx-wide" placeholder="Search cycles…" [value]="addQ()" (input)="addQ.set($any($event.target).value)" aria-label="Search cycles" />
          <div class="cyx-pick">
            @for (c of addable(); track c.id) {
              <label><input type="checkbox" [checked]="addPicked().has(c.id)" (change)="toggleAdd(c.id)" /> {{ c.name }}
                <small>{{ c.createdAt.slice(0, 10) }}@if (c.status === 'RECORDING') { · ● recording }</small></label>
            } @empty { <div class="cyx-empty">No other cycle.</div> }
          </div>
          <div class="dialog-actions">
            <button type="button" class="dialog-btn secondary" (click)="adding.set(false)">Cancel</button>
            <button type="button" class="dialog-btn primary" [disabled]="!addPicked().size" (click)="addPickedCycles()">Add {{ addPicked().size || '' }}</button>
          </div>
        </div>
      </div>
    }

    @if (keysOpen()) {
      <div class="dialog-backdrop" (click)="keysOpen.set(false)">
        <div class="dialog-card cyx-dlg" role="dialog" aria-label="Keyboard" (click)="$event.stopPropagation()">
          <h2>Keyboard</h2>
          <dl class="cyx-keys"><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>move between cycles</dd><dt><kbd>Enter</kbd></dt><dd>open or close the cycle</dd>
            <dt><kbd>Space</kbd></dt><dd>select it</dd><dt><kbd>o</kbd></dt><dd>open its page</dd><dt><kbd>?</kbd></dt><dd>this list</dd><dt><kbd>Esc</kbd></dt><dd>close a menu or dialog</dd></dl>
          <div class="dialog-actions"><button type="button" class="dialog-btn primary" (click)="keysOpen.set(false)">Close</button></div>
        </div>
      </div>
    }

    @if (verdictsOf(); as v) {
      <app-cycle-verdicts-dialog [cycleId]="v.id" [cycleName]="v.name" [project]="project()" [forBoard]="boardId()" (closed)="verdictsOf.set(null)" />
    }`,
})
export class BoardCyclesComponent {
  private readonly api = inject(BoardApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly cycleState = inject(SessionCyclesStateService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly cycleDelete = inject(CycleDeleteService);
  private readonly exporter = inject(CycleExportService);
  private readonly editDialog = inject(EditCycleDialogService);
  private readonly router = inject(Router);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly chat = inject(ChatStateService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  @ViewChildren(CycleRowComponent) private rowViews?: QueryList<CycleRowComponent>;

  readonly empty: ReadonlySet<string> = new Set();
  readonly chips: readonly { key: Chip; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'recording', label: 'Recording' }, { key: 'retests', label: 'Re-tests' }, { key: 'failures', label: 'With failures' }];
  readonly verdictWord = verdictWord;

  private readonly board = signal<BoardSummary | null>(null);
  readonly rows = signal<readonly BoardCycleRow[]>([]);
  readonly summaries = signal<Record<string, CycleSummary>>({});
  readonly marks = signal<Record<string, readonly ItemMark[]>>({});
  readonly found = signal<Record<string, readonly number[]>>({});
  private readonly cards = signal<readonly CardSummary[]>([]);
  readonly claudeSummaries = signal(true);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  readonly recMenu = signal(false);
  readonly q = signal('');
  readonly chip = signal<Chip>('all');
  readonly env = signal('');
  readonly sort = signal<Sort>('newest');
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly showArchived = signal(false);
  readonly keysOpen = signal(false);
  readonly verdictsOf = signal<SessionCycle | null>(null);
  readonly timeline = signal<{ card: TestedCard; verdicts: readonly CardCycleVerdict[] | null; x: number; y: number } | null>(null);
  readonly retest = signal<{ cards: number[]; name: string | null; description: string } | null>(null);
  readonly comparison = signal<{ aId: string; bId: string; aName: string; bName: string; c: Comparison } | null>(null);
  readonly pack = signal<{ cycles: SessionCycle[]; format: 'markdown' | 'json' } | null>(null);
  readonly adding = signal(false);
  readonly addQ = signal('');
  readonly addPicked = signal<ReadonlySet<string>>(new Set());
  private readonly hiddenReady = signal<ReadonlySet<string>>(new Set());
  private readonly hiddenPause = signal<ReadonlySet<string>>(new Set());

  readonly project = computed(() => this.board()?.board.project ?? '');
  private readonly cycleById = computed(() => new Map(this.cycleState.cycles().map((c) => [c.id, c] as const)));
  private readonly joined = computed(() => this.rows().flatMap((row) => {
    const cycle = this.cycleById().get(row.cycleId);
    return cycle ? [{ row, cycle }] : [];
  }));
  readonly archivedRows = computed(() => this.joined().filter((v) => v.row.archived));
  readonly visibleRows = computed(() => this.joined().filter((v) => !v.row.archived));
  readonly baseline = computed(() => this.visibleRows().find((v) => v.row.baseline) ?? null);
  readonly envs = computed(() => [...new Set(this.visibleRows().map((v) => this.envOf(v.row.cycleId)).filter((e): e is string => !!e))]);
  readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    const chip = this.chip();
    const env = this.env();
    const s = this.summaries();
    const list = this.visibleRows().filter((v) => {
      if (chip === 'recording' && v.cycle.status !== 'RECORDING') return false;
      if (chip === 'retests' && v.row.kind !== 'RETEST') return false;
      if (chip === 'failures' && !(s[v.row.cycleId]?.failed)) return false;
      if (env && this.envOf(v.row.cycleId) !== env) return false;
      if (!q) return true;
      const hay = [v.cycle.name, v.cycle.description ?? '', ...v.row.tests.map((t) => `#${t.number} ${t.title}`),
        ...(s[v.row.cycleId]?.endpoints ?? []).map((e) => `${e.method} ${e.path}`)].join(' ').toLowerCase();
      return hay.includes(q);
    });
    const by = this.sort();
    return [...list].sort((a, b) => by === 'oldest' ? a.cycle.createdAt.localeCompare(b.cycle.createdAt)
      : by === 'failures' ? (s[b.row.cycleId]?.failed ?? 0) - (s[a.row.cycleId]?.failed ?? 0)
        : by === 'calls' ? (s[b.row.cycleId]?.calls ?? 0) - (s[a.row.cycleId]?.calls ?? 0)
          : b.cycle.createdAt.localeCompare(a.cycle.createdAt));
  });
  readonly totals = computed(() => {
    const s = this.summaries();
    let calls = 0, failed = 0, acMet = 0, acTotal = 0;
    for (const v of this.visibleRows()) {
      calls += s[v.row.cycleId]?.calls ?? 0;
      failed += s[v.row.cycleId]?.failed ?? 0;
      const m = this.marks()[v.row.cycleId] ?? [];
      const met = m.filter((x) => x.result === 'MEETS').length;
      if (m.length && met >= acMet) { acMet = met; acTotal = m.length; }
    }
    return { calls, failed, acMet, acTotal };
  });
  readonly ready = computed(() => readyToRetest(this.cards(), this.rows(), (id) => this.cycleById().get(id)?.createdAt ?? null, this.hiddenReady()));
  readonly retestChoices = computed(() => {
    const fixed = this.cards().filter((c) => c.status === 'FIXED' || this.retest()?.cards.includes(c.number));
    return [...fixed].sort((a, b) => a.number - b.number);
  });
  readonly rtName = computed(() => {
    const rt = this.retest();
    if (!rt) return '';
    if (rt.name != null) return rt.name;
    const picked = rt.cards.map((n) => this.cards().find((c) => c.number === n)).filter((c): c is CardSummary => !!c);
    return retestName(picked, this.board()?.board.name ?? 'Board');
  });
  readonly addable = computed(() => {
    const on = new Set(this.rows().map((r) => r.cycleId));
    const q = this.addQ().trim().toLowerCase();
    return this.cycleState.cycles().filter((c) => !on.has(c.id) && (!q || c.name.toLowerCase().includes(q))).slice(0, 100);
  });

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => {
        this.hiddenReady.set(readSet(`alfred.cycles.readyHidden.${id}`));
        this.hiddenPause.set(readSet(`alfred.cycles.pauseHidden.${id}`));
        this.load(id);
      });
    });
    const destroy = inject(DestroyRef);
    const sub = inject(BoardSocketService).events$
      .pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted' || !e.what)), auditTime(800))
      .subscribe(() => this.loadRows(this.boardId()));
    // live counters: a cycle of this board caught a call - its summary (and its cards' verdicts) again, never on a timer
    const live = this.cycleState.contentChanged$.pipe(filter((id) => this.rows().some((r) => r.cycleId === id)), auditTime(1500))
      .subscribe((id) => { this.loadSummary(id); this.loadRows(this.boardId()); });
    destroy.onDestroy(() => { sub.unsubscribe(); live.unsubscribe(); });
  }

  private load(id: string): void {
    this.api.board(id).subscribe({
      next: (b) => {
        if (this.boardId() !== id) return;
        this.board.set(b);
        this.api.cards(b.board.project, id, NO_FILTERS, 0, 500).subscribe({ next: (p) => this.cards.set(p.cards), error: () => undefined });
      },
      error: () => this.board.set(null),
    });
    this.api.cyclePrefs(id).subscribe({ next: (p) => this.claudeSummaries.set(p.claudeSummaries), error: () => undefined });
    this.loadRows(id);
  }

  private loadRows(id: string): void {
    this.api.cycleRows(id).subscribe({
      next: (rows) => {
        if (this.boardId() !== id) return;
        const known = this.summaries();
        this.rows.set(rows);
        const missing = rows.filter((r) => !known[r.cycleId]).map((r) => r.cycleId);
        if (!missing.length) return;
        forkJoin(missing.map((c) => this.cyclesApi.summary(c).pipe(catchError(() => of(null)))))
          .subscribe((list) => this.summaries.update((s) => ({ ...s, ...Object.fromEntries(list.flatMap((x) => (x ? [[x.cycleId, x]] : []))) })));
        forkJoin(missing.map((c) => this.api.cycleVerdicts(c, id).pipe(map((v) => [c, v] as const), catchError(() => of(null)))))
          .subscribe((list) => {
            const marks: Record<string, readonly ItemMark[]> = {};
            const found: Record<string, readonly number[]> = {};
            for (const x of list) {
              if (!x) continue;
              marks[x[0]] = x[1].boards.find((b) => b.boardId === id)?.items ?? [];
              found[x[0]] = [...new Set(x[1].calls.flatMap((c) => c.cards.map((k) => k.number)))].sort((a, b) => a - b);
            }
            this.marks.update((m) => ({ ...m, ...marks }));
            this.found.update((f) => ({ ...f, ...found }));
          });
      },
      error: () => this.rows.set([]),
    });
  }

  private loadSummary(cycleId: string): void {
    this.cyclesApi.summary(cycleId).subscribe({ next: (s) => this.summaries.update((all) => ({ ...all, [cycleId]: s })), error: () => undefined });
    this.api.cycleVerdicts(cycleId, this.boardId()).subscribe({
      next: (v) => this.marks.update((m) => ({ ...m, [cycleId]: v.boards.find((b) => b.boardId === this.boardId())?.items ?? [] })),
      error: () => undefined,
    });
  }

  envOf(cycleId: string): string | null {
    return environmentOf(this.summaries()[cycleId] ?? null);
  }

  /** "vs baseline" (else "vs previous") on a row - only when something changed. */
  versusOf(cycleId: string): string | null {
    const other = this.compareTarget(cycleId);
    const base = other ? this.summaries()[other.row.cycleId] : null;
    const now = this.summaries()[cycleId];
    return base && now ? versusLine(other!.row.baseline ? 'baseline' : 'previous', base, now) : null;
  }

  private compareTarget(cycleId: string): { row: BoardCycleRow; cycle: SessionCycle } | null {
    const b = this.baseline();
    if (b && b.row.cycleId !== cycleId) return b;
    const all = [...this.visibleRows()].sort((x, y) => x.cycle.createdAt.localeCompare(y.cycle.createdAt));
    const i = all.findIndex((v) => v.row.cycleId === cycleId);
    return i > 0 ? all[i - 1] : null;
  }

  pauseHintOf(row: BoardCycleRow, cycle: SessionCycle): boolean {
    return this.editable() && !this.hiddenPause().has(row.cycleId) && pauseSuggested(row, cycle.status === 'RECORDING');
  }

  tone(v: CardCycleVerdict): string {
    return v.home ? 'bad' : verdictTone(v.verdict);
  }

  shortTime(cycleId: string): string {
    const at = this.cycleById().get(cycleId)?.createdAt;
    return at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }

  round(v: number): number {
    return Math.round(v);
  }

  select(cycleId: string, on: boolean): void {
    const next = new Set(this.selected());
    if (on) next.add(cycleId); else next.delete(cycleId);
    this.selected.set(next);
  }

  selectedCycles(): SessionCycle[] {
    return this.joined().filter((v) => this.selected().has(v.row.cycleId)).map((v) => v.cycle);
  }

  private sayTimer?: ReturnType<typeof setTimeout>;

  /** One quiet line; a success goes by itself after a few seconds, an error stays until hidden. */
  private say(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
    clearTimeout(this.sayTimer);
    if (!error) this.sayTimer = setTimeout(() => this.message.set(null), 6000);
  }

  // ------------------------------------------------------------------------------------------------------ record

  async record(): Promise<void> {
    this.recMenu.set(false);
    this.busy.set(true);
    const r = await recordForBoard(this.api, this.confirmDialog, this.boardId());
    this.busy.set(false);
    if (r && 'error' in r) this.say(r.error, true);
    else if (r) this.say('Recording - the calls you make now are captured for this board.');
    this.loadRows(this.boardId());
  }

  openRetest(cards: readonly { number: number }[] | null = null): void {
    this.recMenu.set(false);
    const numbers = (cards ?? this.cards().filter((c) => c.status === 'FIXED')).map((c) => c.number);
    this.retest.set({ cards: [...new Set(numbers)], name: null,
      description: 'Re-test after the fixes.\n- [ ] (a step - add METHOD /path so it ticks itself)' });
  }

  toggleRetestCard(n: number): void {
    const rt = this.retest();
    if (!rt) return;
    this.retest.set({ ...rt, cards: rt.cards.includes(n) ? rt.cards.filter((x) => x !== n) : [...rt.cards, n].sort((a, b) => a - b) });
  }

  describeRetest(description: string): void {
    const rt = this.retest();
    if (rt) this.retest.set({ ...rt, description });
  }

  packFormat(format: 'markdown' | 'json'): void {
    const p = this.pack();
    if (p) this.pack.set({ ...p, format });
  }

  renameRetest(name: string): void {
    const rt = this.retest();
    if (rt) this.retest.set({ ...rt, name });
  }

  async startRetest(): Promise<void> {
    const rt = this.retest();
    if (!rt) return;
    this.busy.set(true);
    const r = await recordForBoard(this.api, this.confirmDialog, this.boardId(), 'RETEST',
      { cards: rt.cards, name: this.rtName().trim() || undefined, description: rt.description.trim() || undefined });
    this.busy.set(false);
    if (r && 'error' in r) { this.say(r.error, true); return; }
    this.retest.set(null);
    if (r) this.say(`Recording “${this.rtName() || 'the re-test'}”.`);
    this.loadRows(this.boardId());
  }

  hideReady(): void {
    const next = new Set([...this.hiddenReady(), ...this.ready().map((c) => c.id)]);
    this.hiddenReady.set(next);
    writeSet(`alfred.cycles.readyHidden.${this.boardId()}`, next);
  }

  hidePauseHint(cycleId: string): void {
    const next = new Set([...this.hiddenPause(), cycleId]);
    this.hiddenPause.set(next);
    writeSet(`alfred.cycles.pauseHidden.${this.boardId()}`, next);
  }

  // ------------------------------------------------------------------------------------------------- row actions

  async onAction(cycle: SessionCycle, row: BoardCycleRow, a: CycleRowAction): Promise<void> {
    switch (a) {
      case 'pause': return this.pause(cycle);
      case 'resume':
        this.cyclesApi.startRecording(cycle.id).subscribe({
          next: () => this.say(`Recording into “${cycle.name}” again.`),
          error: (e) => this.say(e?.error?.message || 'Could not resume - another cycle may record this project', true),
        });
        return;
      case 'baseline': return this.flag(cycle.id, { baseline: true });
      case 'unbaseline': return this.flag(cycle.id, { baseline: false });
      case 'archive': return this.flag(cycle.id, { archived: !row.archived });
      case 'remove':
        this.api.relateCycle(this.boardId(), cycle.id, false).subscribe({ next: () => this.loadRows(this.boardId()), error: () => this.say('Could not remove it', true) });
        return;
      case 'delete': {
        const ok = await this.cycleDelete.confirmAndClean([cycle.id], `Delete “${cycle.name}”? Its captured calls go too.`);
        if (ok) this.cyclesApi.delete(cycle.id).subscribe({
          next: () => { this.say(`Deleted “${cycle.name}”.`); this.cycleState.refreshNow(); this.loadRows(this.boardId()); },
          error: () => this.say('Could not delete it', true),
        });
        return;
      }
      case 'pack': return this.openPack([cycle]);
      case 'compare': {
        const other = this.compareTarget(cycle.id);
        if (!other) { this.say('No other cycle to compare with yet.'); return; }
        return this.compare(other.cycle, cycle);
      }
      case 'retest': return this.openRetest(row.tests);
      case 'verdicts': this.verdictsOf.set(cycle); return;
      case 'rename': {
        const result = await this.editDialog.open(cycle);
        if (result) this.cyclesApi.update(cycle.id, { name: result.name, assignedTo: result.assignedTo }).subscribe({ error: () => this.say('Could not rename it', true) });
        return;
      }
      case 'summariesOff': return this.setSummaries(false);
    }
  }

  /** Pause; when Claude answers this board and summaries are on, it is asked for its summary of the cycle. */
  private pause(cycle: SessionCycle): void {
    this.cyclesApi.pauseRecording(cycle.id).subscribe({
      next: () => {
        this.say(`Paused “${cycle.name}” - Resume continues the same cycle.`);
        if (!this.claudeSummaries() || !this.project()) return;
        this.api.liveRunner(this.project()).subscribe({
          next: (runner) => {
            if (!runner) return;
            this.api.requestSkillRun({ project: this.project(), cycleId: this.boardId(), cardNumber: null, command: 'Cycle summary',
              prompt: `The user paused the recording "${cycle.name}" (cycle ${cycle.id}). Write Claude's summary of it with cycle_summary `
                + `(cycleId ${cycle.id}, board ${this.boardId()}): 2-4 sentences - which cards it tests pass, what still fails (the call and `
                + 'the line), what was not reached. Read it with get_cycle and the cards\' re-test checks. Never change the description.' })
              .subscribe({ error: () => undefined });
          },
          error: () => undefined,
        });
      },
      error: (e) => this.say(e?.error?.message || 'Could not pause it', true),
    });
  }

  flag(cycleId: string, flags: { baseline?: boolean; archived?: boolean }): void {
    this.api.setCycleFlags(this.boardId(), cycleId, flags).subscribe({
      next: () => this.loadRows(this.boardId()),
      error: (e) => this.say(e?.error?.message || 'Could not change it', true),
    });
  }

  setSummaries(on: boolean): void {
    this.api.setCyclePrefs(this.boardId(), on).subscribe({
      next: (p) => { this.claudeSummaries.set(p.claudeSummaries); this.say(on ? 'Claude writes a summary when a recording pauses.' : 'Claude no longer writes cycle summaries on this board.'); },
      error: () => this.say('Could not change it', true),
    });
  }

  /** A row saved its notes: the cycles list (which the rows read) at once, before its own signal arrives. */
  cycleChanged(_: SessionCycle): void {
    this.cycleState.refreshNow();
  }

  // --------------------------------------------------------------------------------------------------- dialogs

  showTimeline(card: TestedCard, event: Event): void {
    const r = (event.target as HTMLElement).getBoundingClientRect();
    const hostRect = this.host.nativeElement.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.left - hostRect.left, hostRect.width - 330));
    this.timeline.set({ card, verdicts: null, x, y: r.bottom - hostRect.top + 6 });
    this.api.cardCycleVerdicts(card.cardId).subscribe({
      next: (vs) => {
        const at = (id: string) => this.cycleById().get(id)?.createdAt ?? '';
        const sorted = [...vs].sort((a, b) => at(a.cycleId).localeCompare(at(b.cycleId)));
        this.timeline.update((t) => (t && t.card.cardId === card.cardId ? { ...t, verdicts: sorted } : t));
      },
      error: () => this.timeline.update((t) => (t ? { ...t, verdicts: [] } : t)),
    });
  }

  compareSelected(): void {
    const [a, b] = this.selectedCycles().sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    if (a && b) this.compare(a, b);
  }

  private compare(a: SessionCycle, b: SessionCycle): void {
    const sa = this.summaries()[a.id];
    const sb = this.summaries()[b.id];
    if (!sa || !sb) { this.say('Still counting their calls - try again in a moment.'); return; }
    const ma = this.marks()[a.id] ?? [];
    const mb = this.marks()[b.id] ?? [];
    const met = ma.length || mb.length ? { a: ma.filter((m) => m.result === 'MEETS').length, b: mb.filter((m) => m.result === 'MEETS').length, total: Math.max(ma.length, mb.length) } : undefined;
    this.comparison.set({ aId: a.id, bId: b.id, aName: a.name, bName: b.name, c: compareCycles(sa, sb, met) });
  }

  askCompare(aId: string, bId: string): void {
    const name = (id: string) => (this.cycleById().get(id)?.name ?? id).replace(/[|\]]/g, ' ');
    this.chatSend(`@[cycle:${aId}|${name(aId)}] and @[cycle:${bId}|${name(bId)}]: what changed between these two cycles, and why?`);
    this.comparison.set(null);
  }

  askAboutSelected(): void {
    const refs = this.selectedCycles().map((c) => `@[cycle:${c.id}|${c.name.replace(/[|\]]/g, ' ')}]`).join(' ');
    this.chatSend(`${refs} - what do these cycles show? Which cards pass, what still fails?`);
  }

  private chatSend(text: string): void {
    this.chat.send(this.boardId(), { text });
    this.say('Asked in the board chat.');
  }

  archiveSelected(): void {
    for (const id of this.selected()) this.flag(id, { archived: true });
    this.selected.set(new Set());
  }

  /** Deletes the selected cycles after one confirm that says which mentioned calls are kept; a recording one is skipped. */
  async deleteSelected(): Promise<void> {
    const chosen = this.selectedCycles();
    const deletable = chosen.filter((c) => c.status !== 'RECORDING');
    const skipped = chosen.length - deletable.length;
    if (!deletable.length) { this.say('Pause the recording cycle first - a cycle that records cannot be deleted.', true); return; }
    const what = deletable.length === 1 ? `“${deletable[0].name}”` : `${deletable.length} cycles`;
    const ok = await this.cycleDelete.confirmAndClean(deletable.map((c) => c.id),
      `Delete ${what}? Their captured calls go too.${skipped ? ` (${skipped} recording, not deleted.)` : ''}`);
    if (!ok) return;
    forkJoin(deletable.map((c) => this.cyclesApi.delete(c.id).pipe(map(() => true), catchError(() => of(false))))).subscribe((done) => {
      const failed = done.filter((d) => !d).length;
      this.selected.set(new Set());
      this.say(failed ? `Deleted ${done.length - failed}; ${failed} could not be deleted.` : `Deleted ${what}.`, failed > 0);
      this.cycleState.refreshNow();
      this.loadRows(this.boardId());
    });
  }

  openPack(cycles: SessionCycle[]): void {
    if (cycles.length) this.pack.set({ cycles, format: 'markdown' });
  }

  savePack(): void {
    const p = this.pack();
    if (!p) return;
    for (const c of p.cycles) this.exporter.exportCycle(c, p.format);
    this.pack.set(null);
  }

  openAdd(): void {
    this.addQ.set('');
    this.addPicked.set(new Set());
    this.adding.set(true);
  }

  toggleAdd(id: string): void {
    const next = new Set(this.addPicked());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.addPicked.set(next);
  }

  addPickedCycles(): void {
    const ids = [...this.addPicked()];
    this.adding.set(false);
    forkJoin(ids.map((id) => this.api.relateCycle(this.boardId(), id, true).pipe(catchError(() => of(null)))))
      .subscribe(() => this.loadRows(this.boardId()));
  }

  // --------------------------------------------------------------------------------------------------- keyboard

  keys(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).matches('input,textarea,select,[contenteditable]')) return;
    const rows = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.cyx'));
    const i = rows.indexOf((e.target as HTMLElement).closest('.cyx') as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      return;
    }
    if (i < 0 || (e.target as HTMLElement) !== rows[i]) return;
    const view = this.rowViews?.get(i);
    const v = this.shown()[i];
    if (e.key === 'Enter' && view) { e.preventDefault(); view.setOpen(!view.open()); }
    if (e.key === ' ' && v) { e.preventDefault(); this.select(v.row.cycleId, !this.selected().has(v.row.cycleId)); }
    if (e.key === 'o' && v) void this.router.navigate(['/cycles', v.cycle.id]);
  }

  @HostListener('document:keydown', ['$event'])
  globalKeys(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.matches?.('input,textarea,select,[contenteditable]')) return;
    if (e.key === 'Escape') { this.timeline.set(null); this.recMenu.set(false); this.keysOpen.set(false); }
    if (e.key === '?' && this.host.nativeElement.offsetParent !== null) this.keysOpen.set(true);
  }
}
