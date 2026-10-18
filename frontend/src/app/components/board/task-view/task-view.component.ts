import { WorkItemStripComponent } from '../work-item-strip/work-item-strip.component';
import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, filter } from 'rxjs';
import {
  BriefComment, CardSummary, ChecklistFile, CycleBrief, NO_FILTERS, RequirementsView, SessionLogEntry, TestStep,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { skillArg } from '../../../shared/utils/board-skills';
import {
  NeedItem, REQ_GROUPS, ReqGroup, TAB_GUIDES, TaskTab, briefParts, briefThreads, doneWhen, groupOf, itemsOf,
  needItems, notesOf, phaseOf, requirementsOf, taskRefs, verdictOf,
} from '../../../shared/utils/task-view';
import { CycleBriefComponent } from '../cycle-brief/cycle-brief.component';
import { RunSkillComponent } from '../run-skill/run-skill.component';
import { SpecFilesComponent } from '../spec-files/spec-files.component';
import { ReqFilter, TaskRequirementsComponent } from '../task-requirements/task-requirements.component';
import { BoardFilesComponent } from '../visuals/board-files.component';
import { BoardCyclesComponent } from '../board-cycles/board-cycles.component';
import { TeamRelatedItemsComponent } from '../../team/related-items/related-items.component';

const TAB_KEY = 'alfred.task.tab.';
const GUIDE_KEY = 'alfred.task.guide.';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a browser that refuses storage just forgets
  }
}

/** The bar's colour per group, worst first. */
const BAR: readonly ReqGroup[] = ['MET', 'BUG', 'MISSING', 'FIXED', 'DECIDE', 'CANT_TELL', 'UNTESTED'];

/**
 * A session cycle as the task it is (skills/_shared/rules.md §0, specs/024). The board page's header owns the title, the
 * stage, the Coded → Done ladder (from {@link phaseChange}) and the one next step (specs/032). Its Task tab opens with the
 * ticket chips, the work item, the answer to "does the code match the task?" with a bar, and what needs the user; then tabs: Requirements (the Acceptance items with the calls'
 * verdict and one mark control each), Test plan (steps, data, Done when), Brief (with its comments), Claude's runs,
 * Spec & files. Each tab has "ⓘ How this works". Everything comes from what /board already holds - the same things the
 * MCP's task_context gives any Claude session - and is re-fetched on each /ws/board signal, never polled.
 */
@Component({
  selector: 'app-task-view',
  standalone: true,
  imports: [BoardFilesComponent, CycleBriefComponent, RunSkillComponent, SpecFilesComponent, TaskRequirementsComponent, WorkItemStripComponent, BoardCyclesComponent, TeamRelatedItemsComponent],
  template: `
    <div class="tv">
      <!-- the board page's tabs (Cards, Calls, Task, …): the header above stays, one part shows below -->
      <ng-content select="[tvTabs]" />
      <!-- the page's panes (the live strips first), then this view's own Task tab -->
      <ng-content />
      <div class="tv-task" [hidden]="!showTask()">
      <!-- the task's own facts; its next step, stage and ladder are in the board header (specs/032 D1/D3) -->
      <div class="tv-hd">
        @if (refs().tickets.length || refs().branch) {
          <div class="tv-ids">
            @for (t of refs().tickets; track t) { <span class="tv-chip">{{ t }}</span> }
            @if (refs().branch) { <span class="tv-chip" title="The task's branch">{{ refs().branch }}</span> }
          </div>
        }
        <app-work-item-strip [boardId]="cycleId()" [editable]="editable()" />
        <div class="tv-verdict">
          <span>Does the code match the task? <b [class]="'task-tone-' + verdict().tone">{{ verdict().head }}</b> - {{ verdict().detail }}
            <span class="tv-info" title="Counted from Requirements: met when the calls or your Pass show it works. Bar: green met, red bug or missing, amber re-test, violet Claude suggests, grey can't tell, faint not checked.">ⓘ</span></span>
          @if (bar().length) {
            <span class="tv-bar" aria-hidden="true">
              @for (b of bar(); track b.key) { <i [class]="'tv-g-' + b.key" [style.width.%]="b.pct" [title]="b.n + ' ' + b.label"></i> }
            </span>
          }
        </div>
      </div>
      @if (needs().length) {
        <div class="tv-needs">
          <b>Needs you</b><span class="tv-info" title="Everything on this task waiting for you; click one to go there.">ⓘ</span>
          @for (n of needs(); track n.text) {
            <button type="button" class="tv-it" [class.bad]="n.tone === 'bad'" (click)="need(n)">{{ n.text }}</button>
          }
        </div>
      }
      <div class="tv-tabs" role="tablist">
        @for (t of tabs(); track t.key) {
          <button type="button" role="tab" class="tv-tab" [class.on]="tab() === t.key" [attr.aria-selected]="tab() === t.key" (click)="setTab(t.key)">
            {{ t.label }}@if (t.n) { <span class="tv-n" [class.warn]="t.warn">{{ t.n }}</span> }</button>
        }
      </div>

      <div class="tv-pane">
        @let g = guides[tab()];
        <div class="tv-tabhead">
          <span>{{ g.title }}</span>
          <button type="button" class="tv-info-btn" [class.on]="guideOpen()" title="What is this and how do I decide here?" (click)="toggleGuide()">ⓘ How this works</button>
        </div>
        @if (guideOpen()) {
          <div class="tv-guide">
            <p>{{ g.lead }}</p>
            @if (g.points.length) {
              <div class="tv-flow">
                @for (p of g.points; track p.if) { <span class="tv-if">{{ p.if }} →</span><span>{{ p.then }}</span> }
              </div>
            }
            @if (tab() === 'req') {
              <div class="tv-states">
                @for (s of groupInfo; track s.key) { <span><span [class]="'tv-st tv-g-' + s.key">{{ s.title }}</span> {{ s.hint }}</span> }
              </div>
            }
            <button type="button" class="board-link" (click)="toggleGuide()">hide</button>
          </div>
        }

        @switch (tab()) {
          @case ('req') {
            @if (!reqs().length) {
              <div class="board-dim tv-empty">No requirements yet. A requirement is one Acceptance line of a spec file - the ticket's criteria.
                Add a spec file (Spec &amp; files), or run <b>Write the requirements</b> to draft it from the brief.</div>
            }
            <app-task-requirements [cycleId]="cycleId()" [project]="project()" [editable]="editable()" [reqs]="reqs()" [files]="files()"
                                   [view]="view()" [notes]="notes().notes" [notInTask]="notes().notInTask" [(filter)]="reqFilter"
                                   (changed)="reload()" (cardOpened)="open($event.project, $event.number)" />
          }
          @case ('test') {
            <div class="tv-two">
              <div class="tv-card">
                <h4>How to test it <small>{{ steps().length ? seen() + ' of ' + steps().length + ' seen in the calls' : "the brief's Test steps" }}</small></h4>
                @for (st of steps(); track st.key; let i = $index) {
                  <div class="tv-step">
                    <span [class]="'task-mk ' + (st.state === 'SEEN' ? 'ok' : st.state === 'FAILED' ? 'bad' : '')">{{ st.state === 'SEEN' ? '✓' : st.state === 'FAILED' ? '✗' : '·' }}</span>
                    <span class="tv-no">{{ i + 1 }}</span><span class="tv-grow">{{ st.text }}</span>
                    @if (st.state === 'FAILED' && st.cardNumber) {
                      <button type="button" class="task-pill bad" [title]="st.note ?? ''" (click)="open(project(), st.cardNumber)">#{{ st.cardNumber }}</button>
                    } @else {
                      <span [class]="'task-pill ' + (st.state === 'SEEN' ? 'ok' : st.state === 'FAILED' ? 'bad' : '')" [title]="st.note ?? ''">
                        {{ st.state === 'SEEN' ? st.calls + ' call' + (st.calls === 1 ? '' : 's') : st.state === 'FAILED' ? 'failed' : 'not yet' }}</span>
                    }
                  </div>
                }
                @if (!steps().length) { <div class="board-dim">No test steps - add a numbered list under <code>## Test steps</code> in the brief.</div> }
                <div class="task-rl">Test data <span>what the steps need</span></div>
                @if (data().length) {
                  <ul class="tv-list">@for (d of data(); track $index) { <li>{{ d }}</li> }</ul>
                } @else {
                  <div class="board-dim">None written - add it under <code>## Data</code> in the brief, or searches may come back with 0 rows.</div>
                }
              </div>
              <div class="tv-card">
                <h4>Done when <small>the hand-over rule, checked live</small></h4>
                @for (d of done(); track d.text; let i = $index) {
                  <button type="button" class="tv-dw" [disabled]="d.ok" [title]="d.ok ? '' : 'Go there'" (click)="doneGo(i)">
                    <span [class]="'task-mk ' + (d.ok ? 'ok' : 'bad')">{{ d.ok ? '✓' : '✗' }}</span>{{ d.text }}
                    <span class="board-dim tv-v">{{ d.value }}</span></button>
                }
                <div class="tv-report">
                  <span class="board-dim">{{ ready() ? 'Ready - write the hand-over:' : 'When all three are ✓:' }}</span>
                  <app-run-skill [command]="command('alfred-report')" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" [editable]="editable()" (opened)="open(project(), $event)" />
                </div>
              </div>
            </div>
          }
          @case ('runs') {
            @for (e of log(); track e.id; let first = $first) {
              <details class="tv-run" [open]="first">
                <summary><span class="tv-sk">/{{ e.skill }}</span><span class="board-dim">{{ when(e.at) }}</span><span class="tv-nx">Next: {{ e.next }}</span></summary>
                <div class="tv-run-body">
                  <div class="cd-part cd-part-DID"><div class="cd-ph">✓ Did</div>{{ e.did }}</div>
                  <div class="cd-part cd-part-FOUND"><div class="cd-ph">⚑ Found</div>{{ e.found }}</div>
                  <div class="cd-part cd-part-NEXT"><div class="cd-ph">→ Next</div>{{ e.next }}</div>
                </div>
              </details>
            }
            @if (!log().length) { <div class="board-dim tv-empty">No runs yet - each /alfred-* skill run on this task leaves one entry here.</div> }
          }
          @case ('cycles') { <app-board-cycles [boardId]="cycleId()" [editable]="editable()" /> }
          @case ('items') { <app-team-related-items [boardId]="cycleId()" [editable]="editable()" /> }
          @case ('files') {
            <div class="tv-two">
              <app-spec-files [cycleId]="cycleId()" [editable]="editable()" />
              <div class="board-box">
                <h3>Files <small>attached to this task</small></h3>
                <app-board-files [cycle]="cycleId()" [project]="project()" [canEdit]="editable()" />
              </div>
            </div>
          }
        }
        <!-- the brief stays loaded: the title, the test data and Claude's questions come from it -->
        <app-cycle-brief [hidden]="tab() !== 'brief'" [cycleId]="cycleId()" [project]="project()" [editable]="editable()" [cycleName]="cycleName()"
                         (briefChange)="brief.set($event)" (commentsChange)="comments.set($event)" />
      </div>
      </div>
      @if (error()) { <div class="board-error">{{ error() }}</div> }
    </div>`,
})
export class TaskViewComponent {
  private readonly api = inject(BoardApiService);
  private readonly mentions = inject(BoardMentionsService);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);
  readonly cycleName = input<string | null>(null);
  /** A card was asked for - a host without the board on screen (the cycle page) switches to its Board tab. */
  readonly cardOpened = output<void>();
  /** On the board page (specs/029): Cycles and Related items are the page's own tabs, not this one's. */
  readonly nested = input(false);
  /** The page's Task tab is the one showing; the header always shows. */
  readonly showTask = input(true);
  /** A Needs-you item or a guide link went to one of this view's tabs: the page shows its Task tab. */
  readonly taskAsked = output<void>();
  /** 0 Coded … 4 Done, for the board header's ladder (specs/032 D3) - computed here, where the task's data is read. */
  readonly phaseChange = output<number>();

  readonly brief = signal<CycleBrief | null>(null);
  readonly comments = signal<readonly BriefComment[]>([]);
  readonly files = signal<readonly ChecklistFile[]>([]);
  readonly view = signal<RequirementsView | null>(null);
  readonly cards = signal<readonly CardSummary[]>([]);
  readonly steps = signal<readonly TestStep[]>([]);
  readonly log = signal<readonly SessionLogEntry[]>([]);
  /** The cycle's spec files, for the Spec & files tab's count. */
  readonly specCount = signal(0);
  readonly error = signal<string | null>(null);
  readonly tab = signal<TaskTab>('req');
  readonly reqFilter = signal<ReqFilter>('all');
  private readonly guideState = signal<Readonly<Record<string, boolean>>>({});

  readonly guides = TAB_GUIDES;
  readonly groupInfo = REQ_GROUPS;

  readonly parts = computed(() => briefParts(this.brief()?.text ?? ''));
  readonly refs = computed(() => taskRefs(this.parts().sections['task']));
  readonly data = computed(() => itemsOf(this.parts().sections['data']));
  readonly reqs = computed(() => requirementsOf(this.files(), this.cards()));
  readonly notes = computed(() => notesOf(this.cards(), this.reqs()));
  readonly verdict = computed(() => verdictOf(this.reqs()));
  readonly phase = computed(() => phaseOf(this.reqs(), this.cards(), this.steps(), this.log()));
  readonly done = computed(() => doneWhen(this.reqs(), this.cards()));
  readonly ready = computed(() => this.done().every((d) => d.ok));
  readonly threads = computed(() => briefThreads(this.comments()));
  readonly needs = computed(() => needItems(this.reqs(), this.cards(), this.steps(), this.threads().open.filter((t) => t.asksYou).length));
  readonly seen = computed(() => this.steps().filter((s) => s.state === 'SEEN').length);

  readonly bar = computed(() => {
    const all = this.reqs();
    return BAR.map((key) => {
      const n = all.filter((r) => groupOf(r) === key).length;
      const info = REQ_GROUPS.find((g) => g.key === key)!;
      return { key, n, pct: all.length ? (n / all.length) * 100 : 0, label: info.title.toLowerCase() };
    }).filter((b) => b.n > 0);
  });

  readonly tabs = computed(() => {
    const open = this.reqs().filter((r) => groupOf(r) !== 'MET').length;
    const threads = this.threads();
    const t: { key: TaskTab; label: string; n: string; warn: boolean }[] = [
      { key: 'req', label: 'Requirements', n: this.reqs().length ? `${open} open` : '', warn: open > 0 },
      { key: 'test', label: 'Test plan', n: this.steps().length ? `${this.seen()} / ${this.steps().length}` : '', warn: false },
      { key: 'brief', label: 'Brief', n: threads.open.length ? `💬 ${threads.open.length}` : '', warn: threads.open.some((x) => x.asksYou) },
      { key: 'runs', label: "Claude's runs", n: this.log().length ? String(this.log().length) : '', warn: false },
      { key: 'files', label: 'Spec & files', n: this.specCount() ? String(this.specCount()) : '', warn: false },
      { key: 'cycles', label: 'Cycles', n: '', warn: false },
      { key: 'items', label: 'Related items', n: '', warn: false },
    ];
    return this.nested() ? t.filter((x) => x.key !== 'cycles' && x.key !== 'items') : t;
  });

  /** A tab's guide is open until the user hides it, then stays hidden (per tab, in this browser). */
  readonly guideOpen = computed(() => {
    const t = this.tab();
    return this.guideState()[t] ?? stored(GUIDE_KEY + t) !== 'closed';
  });

  readonly arg = computed(() => skillArg(this.cycleName() ?? this.cycleId()));

  constructor() {
    effect(() => this.phaseChange.emit(this.phase()));
    effect(() => {
      const id = this.cycleId();
      untracked(() => {
        const t = stored(TAB_KEY + id) as TaskTab | null;
        this.tab.set(t && TAB_GUIDES[t] && !(this.nested() && (t === 'cycles' || t === 'items')) ? t : 'req');
        this.reqFilter.set('all');
        this.load(id);
      });
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && (e.cycleId === this.cycleId() || (!e.cycleId && e.project !== undefined))
        && e.what !== 'brief-comments'),
      debounceTime(150),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  command(skill: string): string {
    return `/${skill} ${this.arg()}`;
  }

  setTab(t: TaskTab): void {
    this.tab.set(t);
    store(TAB_KEY + this.cycleId(), t);
  }

  go(t: TaskTab, f?: ReqFilter): void {
    this.setTab(t);
    this.taskAsked.emit();
    if (f) this.reqFilter.set(f);
  }

  need(n: NeedItem): void {
    if (n.card) this.open(n.card.project, n.card.number);
    else if (n.tab) this.go(n.tab, n.filter);
  }

  /** A ✗ in Done when leads to what is left. */
  doneGo(i: number): void {
    if (i === 0) this.go('req', 'open');
    else if (i === 1) this.go('req', 'BUG');
    else this.go('req', 'FIXED');
  }

  toggleGuide(): void {
    const t = this.tab();
    const open = !this.guideOpen();
    this.guideState.update((s) => ({ ...s, [t]: open }));
    store(GUIDE_KEY + t, open ? 'open' : 'closed');
  }

  reload(): void {
    this.load(this.cycleId());
  }

  private load(id: string): void {
    const mine = () => id === this.cycleId();
    this.api.checklist(id).subscribe({ next: (f) => mine() && this.files.set(f), error: (e) => this.error.set(messageOf(e)) });
    // an Alfred without the requirement check answers 404: the rows show without the calls' pill
    this.api.requirements(id).subscribe({ next: (v) => mine() && this.view.set(v), error: () => this.view.set(null) });
    this.api.cards('', id, NO_FILTERS).subscribe({ next: (p) => mine() && this.cards.set(p.cards), error: () => this.cards.set([]) });
    this.api.steps(id).subscribe({ next: (s) => mine() && this.steps.set(s), error: () => this.steps.set([]) });
    this.api.sessionLog(id, 10).subscribe({ next: (l) => mine() && this.log.set(l), error: () => this.log.set([]) });
    this.api.specs(id).subscribe({ next: (f) => mine() && this.specCount.set(f.length), error: () => this.specCount.set(0) });
  }

  open(project: string, number: number): void {
    this.mentions.cardToOpen.set({ project, number });
    this.cardOpened.emit();
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }

}
