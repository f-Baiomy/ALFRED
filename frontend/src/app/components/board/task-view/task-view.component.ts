import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, filter } from 'rxjs';
import {
  CardSummary, ChecklistFile, CycleBrief, MARK_LABELS, Mark, NO_FILTERS, SessionLogEntry, TestStep,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { skillArg } from '../../../shared/utils/board-skills';
import { copyToClipboard } from '../../../shared/utils/clipboard';
import {
  PHASES, REQ_LABELS, ReqState, Requirement, briefParts, countStates, doneWhen, itemsOf, needsYou, notesOf, phaseOf,
  requirementsOf, taskRefs, verdictOf,
} from '../../../shared/utils/task-view';
import { AcceptanceChecklistComponent } from '../acceptance-checklist/acceptance-checklist.component';
import { CycleBriefComponent } from '../cycle-brief/cycle-brief.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { SpecFilesComponent } from '../spec-files/spec-files.component';

type Tile = ReqState | 'NOTES' | 'NOT_IN_TASK';

/**
 * A session cycle as the task it is (skills/_shared/rules.md §0): where it stands, one answer to "does the code match
 * the task?", the brief, each requirement (an Acceptance item) with its state, cards and evidence, Claude's notes and
 * "changed, but not in the task", what needs the user, the test steps, and the hand-over rule. Everything comes from
 * what /board already holds - the same things the MCP's task_context gives any Claude session - and is re-fetched on
 * each /ws/board signal, never polled. The spec files and the full acceptance checklist stay beside it unchanged.
 */
@Component({
  selector: 'app-task-view',
  standalone: true,
  imports: [AcceptanceChecklistComponent, CycleBriefComponent, MarkdownViewComponent, SpecFilesComponent],
  template: `
    <div class="task-head">
      <div class="task-title">
        @for (t of refs().tickets; track t) { <span class="task-chip task-ticket">{{ t }}</span> }
        <b>{{ title() }}</b>
        @if (refs().branch) { <span class="task-chip" title="The task's branch">{{ refs().branch }}</span> }
      </div>
      <div class="task-phase" aria-label="Where the task stands">
        @for (ph of phases; track ph; let i = $index) {
          @if (i) { <span class="task-ph-arrow">→</span> }
          <span class="task-ph" [class.done]="i < phase()" [class.now]="i === phase()">{{ ph }}</span>
        }
      </div>
    </div>

    <div class="task-verdict">
      <div>
        <div class="task-v-q">Does the code match the task?</div>
        <div class="task-v-a"><b [class]="'task-tone-' + verdict().tone">{{ verdict().head }}</b> - {{ verdict().detail }}</div>
      </div>
      <div class="task-tiles">
        @for (t of tiles(); track t.key) {
          <button type="button" [class]="'task-tile task-t-' + t.key" [class.on]="only() === t.key" [disabled]="!t.n"
                  [title]="only() === t.key ? 'Show everything' : 'Show only these'" (click)="only.set(only() === t.key ? null : t.key)">
            <b>{{ t.n }}</b>{{ t.label }}</button>
        }
      </div>
      <div class="task-cmds">
        @for (cmd of commands(); track cmd) {
          <button type="button" class="board-copy" [title]="'Copy ' + cmd + ' - paste it into Claude Code'" (click)="copy(cmd)">
            {{ copied() === cmd ? '✓ copied' : '⧉ ' + cmd }}</button>
        }
      </div>
    </div>

    <div class="board-brief">
      <div class="task-main">
        <app-cycle-brief [cycleId]="cycleId()" [project]="project()" [editable]="editable()" [cycleName]="cycleName()"
                         (briefChange)="brief.set($event)" />

        @if (show('REQ')) {
          <div class="board-box">
            <h3>Requirements
              <small>{{ reqs().length ? 'the Acceptance items of the spec files · result from the recorded calls' : 'none yet' }}</small></h3>
            @if (!reqs().length) {
              <div class="board-dim">A requirement is one Acceptance line of a spec file - the ticket's criteria. Add a spec file (beside), or
                <code>/alfred-spec {{ arg() }}</code> drafts it from the brief.</div>
            }
            @for (r of openReqs(); track r.label) {
              <div [class]="'task-req task-r-' + r.state">
                <div class="task-req-top">
                  <span [class]="'task-dot task-dot-' + r.state">{{ stateLabels[r.state] }}</span>
                  <b>{{ r.label }} · {{ r.item.text }}</b>
                  <span class="task-req-cards">
                    @for (c of r.cards; track c.number) {
                      <button type="button" class="board-link" [title]="c.title + ' (' + c.status + ')'" (click)="open(c.project, c.number)">#{{ c.number }}</button>
                    }
                  </span>
                </div>
                @if (r.evidence) {
                  <div class="task-req-row"><span class="task-rl">{{ r.byUser ? 'You' : '✦ Claude' }}</span>
                    <app-markdown-view [text]="r.evidence" /></div>
                }
                <div class="task-req-row"><span class="task-rl">From</span>
                  <span class="board-dim">{{ r.fileName }}{{ r.suggested ? ' · Claude suggests it - your mark decides' : r.byUser ? ' · marked by you' : '' }}
                    @if (r.state === 'MISSING') { · not built yet - a task, not a bug }
                    @if (r.state === 'FIXED') { · use the app as the card's re-test says, then /alfred-verify }
                  </span></div>
                @if (editable()) {
                  <div class="task-req-acts">
                    @if (r.suggested) {
                      <button type="button" class="board-tog on" title="Mark it as Claude suggests" (click)="accept(r)">Accept ✦</button>
                    }
                    @for (m of marks; track m) {
                      <button type="button" class="board-tog" [class.on]="r.item.mark?.mark === m" (click)="mark(r, m)">{{ markLabels[m] }}</button>
                    }
                  </div>
                }
              </div>
            }
            @if (metReqs().length) {
              <details class="task-met">
                <summary><span class="task-dot task-dot-MET">MET</span> {{ metReqs().length }} requirement{{ metReqs().length === 1 ? '' : 's' }} met</summary>
                @for (r of metReqs(); track r.label) {
                  <div class="task-met-row">
                    <span class="task-mk ok">✓</span><span>{{ r.label }} · {{ r.item.text }}</span>
                    <span class="board-dim">{{ r.byUser ? 'marked by you' : '✦ Claude suggests' }}</span>
                    @if (editable() && r.suggested) { <button type="button" class="board-tog on" (click)="accept(r)">Accept ✦</button> }
                  </div>
                }
              </details>
            }
          </div>
        }

        @if (show('NOTES') && notes().notes.length) {
          <div class="board-box">
            <h3>Claude's notes <small>not tied to a requirement - worth knowing</small></h3>
            @for (n of notes().notes; track n.card.id) {
              <div class="task-note">
                <span [class]="'task-kind task-kind-' + n.tag">{{ n.tag }}</span><span>{{ n.title }}</span>
                <button type="button" class="board-link" (click)="open(n.card.project, n.card.number)">#{{ n.card.number }}</button>
              </div>
            }
          </div>
        }

        @if (show('NOT_IN_TASK') && notes().notInTask.length) {
          <div class="board-box">
            <h3>Changed, but not in the task <small>from the branch diff - scope creep, or a requirement nobody wrote down</small></h3>
            @for (n of notes().notInTask; track n.card.id) {
              <div class="task-note">
                <span class="task-kind task-kind-EXTRA">EXTRA</span><span>{{ n.title }}</span>
                <button type="button" class="board-link" (click)="open(n.card.project, n.card.number)">#{{ n.card.number }}</button>
              </div>
            }
          </div>
        }

        @if (log().length) {
          <div class="board-box">
            <h3>Claude's runs <small>the session log - what each skill did, found and left next</small></h3>
            @for (e of log(); track e.id) {
              <div class="board-log-entry">
                <div class="board-dim">✦ Claude · /{{ e.skill }} · {{ when(e.at) }}</div>
                <div><span class="board-ev-label">DID</span>{{ e.did }}</div>
                <div><span class="board-ev-label">FOUND</span>{{ e.found }}</div>
                <div><span class="board-ev-label">NEXT</span>{{ e.next }}</div>
              </div>
            }
          </div>
        }
      </div>

      <div class="board-brief-side">
        @if (needs().length) {
          <div class="board-box task-needs">
            <h3>Needs you <small>{{ needs().length }}</small></h3>
            @for (n of needs(); track n.card.id) {
              <div class="task-need">
                <button type="button" class="board-link" (click)="open(n.card.project, n.card.number)">#{{ n.card.number }}</button>
                <span>{{ n.card.title }}</span><span class="board-dim">{{ n.why }}</span>
              </div>
            }
          </div>
        }

        <div class="board-box">
          <h3>How to test it <small>{{ steps().length ? steps().length + ' step' + (steps().length === 1 ? '' : 's') + ' · ticked by listen and review' : "the brief's Test steps" }}</small></h3>
          @for (st of steps(); track st.key; let i = $index) {
            <div class="task-step">
              <span [class]="'task-mk ' + (st.state === 'SEEN' ? 'ok' : st.state === 'FAILED' ? 'bad' : '')">{{ st.state === 'SEEN' ? '✓' : st.state === 'FAILED' ? '✗' : '·' }}</span>
              <span>{{ i + 1 }}. {{ st.text }}</span>
              @if (st.state === 'FAILED' && st.cardNumber) {
                <button type="button" class="task-pill bad" [title]="st.note ?? ''" (click)="open(project(), st.cardNumber)">#{{ st.cardNumber }}</button>
              } @else {
                <span [class]="'task-pill ' + (st.state === 'SEEN' ? 'ok' : st.state === 'FAILED' ? 'bad' : '')" [title]="st.note ?? ''">
                  {{ st.state === 'SEEN' ? st.calls + ' call' + (st.calls === 1 ? '' : 's') : st.state === 'FAILED' ? 'failed' : 'not yet' }}</span>
              }
            </div>
          }
          @if (!steps().length) { <div class="board-dim">No test steps - add a numbered list under <code>## Test steps</code> in the brief.</div> }
          @if (data().length) {
            <div class="task-data"><span class="task-rl">Data</span>
              @for (d of data(); track $index) { <span class="task-chip task-follow">{{ d }}</span> }</div>
          }
        </div>

        <div class="board-box">
          <h3>Done when <small>the hand-over rule, checked live</small></h3>
          @for (d of done(); track d.text) {
            <div class="task-step"><span [class]="'task-mk ' + (d.ok ? 'ok' : 'bad')">{{ d.ok ? '✓' : '✗' }}</span>{{ d.text }}
              <span class="board-dim task-step-value">{{ d.value }}</span></div>
          }
          <div class="board-cycle-cmds">
            <button type="button" class="board-copy" (click)="copy(report())">{{ copied() === report() ? '✓ copied' : '⧉ ' + report() }}</button>
          </div>
        </div>

        <app-spec-files [cycleId]="cycleId()" [editable]="editable()" />
        <app-acceptance-checklist [cycleId]="cycleId()" [project]="project()" [editable]="editable()" />
      </div>
    </div>
    @if (error()) { <div class="board-error">{{ error() }}</div> }`,
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

  readonly brief = signal<CycleBrief | null>(null);
  readonly files = signal<readonly ChecklistFile[]>([]);
  readonly cards = signal<readonly CardSummary[]>([]);
  readonly steps = signal<readonly TestStep[]>([]);
  readonly log = signal<readonly SessionLogEntry[]>([]);
  readonly only = signal<Tile | null>(null);
  readonly copied = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  readonly phases = PHASES;
  readonly stateLabels = REQ_LABELS;
  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly markLabels = MARK_LABELS;

  readonly parts = computed(() => briefParts(this.brief()?.text ?? ''));
  readonly refs = computed(() => taskRefs(this.parts().sections['task']));
  readonly title = computed(() => this.parts().goal.split(/\r?\n/)[0]?.replace(/[*_`]/g, '').trim() || this.cycleName() || 'This task');
  readonly data = computed(() => itemsOf(this.parts().sections['data']));
  readonly reqs = computed(() => requirementsOf(this.files(), this.cards()));
  readonly counts = computed(() => countStates(this.reqs()));
  readonly notes = computed(() => notesOf(this.cards(), this.reqs()));
  readonly verdict = computed(() => verdictOf(this.reqs()));
  readonly phase = computed(() => phaseOf(this.reqs(), this.cards(), this.steps(), this.log()));
  readonly done = computed(() => doneWhen(this.reqs(), this.cards()));
  readonly needs = computed(() => needsYou(this.cards()));
  readonly openReqs = computed(() => this.reqs().filter((r) => r.state !== 'MET' && (!this.only() || this.only() === r.state)));
  readonly metReqs = computed(() => this.reqs().filter((r) => r.state === 'MET' && (!this.only() || this.only() === 'MET')));

  readonly tiles = computed(() => {
    const c = this.counts();
    const t: { key: Tile; n: number; label: string }[] = [
      { key: 'MET', n: c.MET, label: 'met' },
      { key: 'BUG', n: c.BUG, label: 'bug' },
      { key: 'MISSING', n: c.MISSING, label: 'missing' },
      { key: 'FIXED', n: c.FIXED, label: 're-test' },
      { key: 'CANT_TELL', n: c.CANT_TELL, label: "can't tell" },
      { key: 'UNTESTED', n: c.UNTESTED, label: 'not checked' },
      { key: 'NOTES', n: this.notes().notes.length, label: 'notes' },
      { key: 'NOT_IN_TASK', n: this.notes().notInTask.length, label: 'not in task' },
    ];
    return t.filter((x) => x.n > 0 || ['MET', 'BUG', 'MISSING'].includes(x.key));
  });

  readonly arg = computed(() => skillArg(this.cycleName() ?? this.cycleId()));
  readonly commands = computed(() => [`/alfred-review ${this.arg()}`, `/alfred-listen ${this.arg()}`, `/alfred-spec ${this.arg()}`]);
  readonly report = computed(() => `/alfred-report ${this.arg()}`);

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => {
        this.only.set(null);
        this.load(id);
      });
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && (e.cycleId === this.cycleId() || (!e.cycleId && e.project !== undefined))),
      debounceTime(150),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  /** Which sections show while a tile filters: requirements for a requirement state, else that list. */
  show(what: 'REQ' | 'NOTES' | 'NOT_IN_TASK'): boolean {
    const only = this.only();
    if (!only) return true;
    if (what === 'REQ') return only !== 'NOTES' && only !== 'NOT_IN_TASK';
    return only === what;
  }

  private load(id: string): void {
    this.api.checklist(id).subscribe({ next: (f) => this.files.set(f), error: (e) => this.error.set(messageOf(e)) });
    this.api.cards('', id, NO_FILTERS).subscribe({ next: (p) => this.cards.set(p.cards), error: () => this.cards.set([]) });
    this.api.steps(id).subscribe({ next: (s) => this.steps.set(s), error: () => this.steps.set([]) });
    this.api.sessionLog(id, 10).subscribe({ next: (l) => this.log.set(l), error: () => this.log.set([]) });
  }

  mark(r: Requirement, mark: Mark): void {
    this.api.mark(this.cycleId(), r.fileName, r.item.key, mark, r.item.mark?.evidence ?? '').subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  accept(r: Requirement): void {
    this.api.acceptSuggestion(this.cycleId(), r.fileName, r.item.key).subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  open(project: string, number: number): void {
    this.mentions.cardToOpen.set({ project, number });
    this.cardOpened.emit();
  }

  copy(text: string): void {
    void copyToClipboard(text).then(() => {
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
