import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardCycleRow, CycleSummary, TestedCard } from '../../../core/models/cycles-tab.models';
import { ItemMark } from '../../../core/models/board.models';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { CycleSpacer } from '../../../core/state/call-selection.tokens';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import {
  StoryStep, descriptionProse, hotSpots, markStep, parseSteps, stepState, storySteps, verdictTone, verdictWord,
} from '../../../shared/utils/cycle-tab';

/** What a row asks its list to do - the list owns dialogs, flags and recording. */
export type CycleRowAction = 'pause' | 'resume' | 'baseline' | 'unbaseline' | 'archive' | 'remove' | 'delete' | 'pack' | 'compare'
  | 'retest' | 'verdicts' | 'rename' | 'summariesOff';

/**
 * One cycle of the board's Cycles tab (specs/033): three short lines closed - the name, one line of facts with its cards
 * as number chips coloured by verdict, the description's first line - and Overview / Story / Calls / Requirements when
 * open. Nothing opens by itself; a suggestion is one line and goes when dismissed.
 */
@Component({
  selector: 'app-cycle-row',
  standalone: true,
  imports: [RouterLink, CloseOnOutsideDirective],
  template: `
    @let c = cycle();
    @let r = row();
    @let s = summary();
    <div class="cyx" [class.rec]="c.status === 'RECORDING'" [class.open]="open()" tabindex="0" [attr.data-cycle]="c.id">
      <div class="cyx-top" (click)="toggleOpen($event)">
        <input type="checkbox" [checked]="selected()" (change)="selectedChange.emit(!selected())" aria-label="Select this cycle" />
        <span class="cyx-chev" aria-hidden="true">▸</span>
        <div class="cyx-main">
          <div class="cyx-title">
            <span class="cyx-dot"></span>
            <span class="cyx-name"><a [routerLink]="['/cycles', c.id]" (click)="$event.stopPropagation()">{{ c.name }}</a></span>
            @if (r.baseline) { <span class="cyx-tag base" title="Compare and “vs baseline” use this cycle">⚑ baseline</span> }
            @if (env()) { <span class="cyx-tag" title="From the hosts its calls went to">{{ env() }}</span> }
          </div>
          <div class="cyx-sub">
            @if (c.status === 'RECORDING') { <span class="cyx-recpill">● REC</span> } @else if (when()) { <span>{{ when() }}</span> }
            @if (r.kind === 'RETEST') { <span class="cyx-kind">↻ re-test</span> }
            @if (r.tests.length) {
              <span class="cyx-cdots">
                @for (t of r.tests; track t.cardId) {
                  <button type="button" class="cyx-cdot" [class]="'cyx-cdot ' + tone(t)" [title]="'#' + t.number + ' ' + t.title + ' - ' + word(t)"
                          (click)="$event.stopPropagation(); cardTimeline.emit({ card: t, event: $event })">#{{ t.number }}</button>
                }
              </span>
            } @else if (found().length) {
              <span>found</span>
              <span class="cyx-cdots">@for (n of found().slice(0, 4); track n) { <span class="cyx-cdot">#{{ n }}</span> }</span>
            }
            @if (s) {
              <span><span class="cyx-live">{{ s.calls }}</span> calls @if (s.failed) { · <span class="cyx-bad">{{ s.failed }} failed</span> }</span>
            }
            @if (acTotal()) { <span [title]="'Requirements met in this cycle'">AC {{ acMet() }}/{{ acTotal() }}</span> }
            @if (otherBoards()) { <span class="cyx-shared" [title]="'Also on ' + otherBoards() + ' other board(s)'">shared · {{ otherBoards() }}</span> }
            @if (versus()) { <button type="button" class="cyx-link" (click)="$event.stopPropagation(); act('compare')">{{ versus() }} →</button> }
            @if (s && s.strip.length) {
              <span class="cyx-spark" aria-hidden="true">
                @for (p of spark(); track $index) { <i [class.e]="(p.status ?? 0) >= 500 || (p.failed && !p.status)" [class.w]="(p.status ?? 0) >= 400 && (p.status ?? 0) < 500" [style.height.px]="p.h"></i> }
              </span>
            }
          </div>
          @if (prose()) { <div class="cyx-desc">{{ firstLine() }}</div> }
          @if (pauseHint()) {
            <div class="cyx-suggest" (click)="$event.stopPropagation()">
              <span>✓ All {{ r.tests.length }} cards were checked in this cycle. <b>Pause the recording?</b></span>
              <button type="button" class="action-btn" (click)="act('pause')">⏸ Pause</button>
              <button type="button" class="cyx-ghost" (click)="dismissPause.emit()">Keep recording</button>
            </div>
          }
        </div>
        <div class="cyx-acts" (click)="$event.stopPropagation()">
          @if (editable()) {
            @if (c.status === 'RECORDING') { <button type="button" class="action-btn" (click)="act('pause')">⏸ Pause</button> }
            @else { <button type="button" class="action-btn" (click)="act('resume')">● Resume</button> }
          }
          <div class="cyx-more" [appCloseOnOutside]="menu()" (closed)="menu.set(false)">
            <button type="button" class="cyx-ghost" aria-label="More" [attr.aria-expanded]="menu()" (click)="menu.set(!menu())">⋯</button>
            @if (menu()) {
              <div class="cyx-menu">
                @if (editable()) {
                  <button type="button" (click)="act('rename')">✎ Rename</button>
                  @if (r.baseline) { <button type="button" (click)="act('unbaseline')">⚑ Unset baseline</button> }
                  @else { <button type="button" (click)="act('baseline')">⚑ Set as baseline</button> }
                }
                <button type="button" (click)="act('compare')">⇄ Compare with {{ hasBaseline() && !r.baseline ? 'the baseline' : 'the previous cycle' }}</button>
                <button type="button" (click)="act('verdicts')">✓ Verdicts per call</button>
                @if (editable() && r.tests.length) { <button type="button" (click)="act('retest')">↻ Re-test its cards…</button> }
                <button type="button" (click)="act('pack')">📦 Evidence pack…</button>
                @if (editable()) {
                  <hr />
                  @if (claudeSummaries()) { <button type="button" (click)="act('summariesOff')">✦ Stop Claude's summaries on this board</button> }
                  <button type="button" (click)="act('archive')">🗄 {{ r.archived ? 'Restore' : 'Archive' }}</button>
                  <button type="button" (click)="act('remove')">Remove from board</button>
                  @if (c.status !== 'RECORDING') { <button type="button" class="cyx-danger" (click)="act('delete')">🗑 Delete cycle…</button> }
                }
              </div>
            }
          </div>
        </div>
      </div>

      @if (open()) {
        <div class="cyx-body">
          <div class="cyx-subtabs" role="tablist">
            @for (t of tabs; track t.key) {
              <button type="button" role="tab" [class.on]="tab() === t.key" (click)="openTab(t.key)">{{ t.label }}@if (t.key === 'calls' && s) { · {{ s.calls }} }</button>
            }
          </div>

          @switch (tab()) {
            @case ('overview') {
              <div class="cyx-ov">
                <div>
                  <div class="cyx-sec">
                    <h4>Description <span class="cyx-grow"></span>
                      @if (editable() && !editing()) { <button type="button" class="cyx-ghost" (click)="startEdit()">✎ Edit</button> }
                    </h4>
                    @if (editing()) {
                      <textarea class="cyx-text" [value]="draft()" (input)="draft.set($any($event.target).value)" maxlength="20000"
                                placeholder="What this cycle is for, what you expect. Steps: one per line as “- [ ] Search POST /api/search” - a step with an endpoint ticks itself."></textarea>
                      <div class="cyx-row-actions">
                        <button type="button" class="action-btn primary" [disabled]="saving()" (click)="saveDescription()">Save</button>
                        <button type="button" class="action-btn" (click)="editing.set(false)">Cancel</button>
                      </div>
                    } @else if (prose() || steps().length) {
                      @if (prose()) { <div class="cyx-prose">{{ prose() }}</div> }
                      @if (steps().length) {
                        <ul class="cyx-steps">
                          @for (st of stepRows(); track st.step.line) {
                            <li [class.done]="st.state.done">
                              <button type="button" class="cyx-box" [disabled]="!editable()" [attr.aria-pressed]="st.state.done"
                                      [title]="st.state.by === 'calls' ? 'Ticked by a call - click to mark it not done' : 'Click to mark it ' + (st.state.done ? 'not done' : 'done')"
                                      (click)="toggleStep(st.step.line, !st.state.done)">{{ st.state.done ? '✓' : '' }}</button>
                              <span>{{ st.step.text }}
                                @if (st.state.point) { <small>· call at {{ time(st.state.point.at) }}</small> }
                                @else if (st.state.by === 'hand') { <small>· by hand</small> }
                                @else if (!st.step.endpoint) { <small>· tick it yourself</small> }
                              </span>
                            </li>
                          }
                        </ul>
                      }
                    } @else {
                      <div class="cyx-empty">No description yet - what this cycle is for, its steps (“- [ ] step”), what you expect.</div>
                    }
                    @if (error()) { <div class="cyx-err">{{ error() }}</div> }
                  </div>
                  @if (c.summary) {
                    <div class="cyx-sec">
                      <h4>Claude's summary <span class="cyx-grow"></span>
                        @if (editable()) { <button type="button" class="cyx-ghost" (click)="removeSummary()">Remove</button> }
                      </h4>
                      <div class="cyx-summary"><div class="cyx-who">✦ Claude · written when the recording paused · your description is not changed</div>{{ c.summary }}</div>
                    </div>
                  }
                </div>
                <div>
                  <div class="cyx-sec">
                    <h4>Cards</h4>
                    @if (r.tests.length) {
                      <div class="cyx-clist">
                        @for (t of r.tests; track t.cardId) {
                          <button type="button" (click)="cardTimeline.emit({ card: t, event: $event })">
                            <span class="cyx-n">#{{ t.number }}</span><span>{{ t.title }}<br /><small>{{ t.status.replace('_', ' ').toLowerCase() }}</small></span>
                            <span [class]="'cyx-v ' + tone(t)">{{ word(t) }}</span>
                          </button>
                        }
                      </div>
                    } @else { <div class="cyx-empty">No card linked - a re-test made from cards links them.</div> }
                  </div>
                  @if (hot().length) {
                    <div class="cyx-sec">
                      <h4>Hot spots</h4>
                      <div class="cyx-hot">
                        @for (h of hot(); track h.method + h.path) {
                          <button type="button" (click)="openTab('calls', h.method + ' ' + h.path)">
                            <span>{{ h.method }} {{ h.path }}</span>
                            <span [class.cyx-bad]="h.failed">@if (h.failed) { {{ h.failed }} failed · } {{ ms(h.maxMs) }}</span>
                          </button>
                        }
                      </div>
                    </div>
                  }
                  <div class="cyx-sec">
                    <h4>Facts</h4>
                    <dl class="cyx-facts">
                      <dt>Created</dt><dd>{{ c.createdAt.slice(0, 16).replace('T', ' ') }}</dd>
                      @if (s) {
                        <dt>Calls</dt><dd>{{ s.calls }} · {{ s.endpoints.length }} endpoints @if (s.lastAt) { · last {{ time(s.lastAt) }} }</dd>
                        @if (s.medianMs != null) { <dt>Median time</dt><dd>{{ ms(s.medianMs) }}</dd> }
                        @if (s.hosts.length) { <dt>Hosts</dt><dd>{{ s.hosts.join(', ') }}</dd> }
                      }
                      @if (sql() != null) { <dt>Captured</dt><dd>◆ {{ sql() }} SQL statements</dd> }
                      <dt>Also on</dt><dd>{{ otherBoards() ? otherBoards() + ' other board(s)' : 'no other board' }}</dd>
                    </dl>
                  </div>
                </div>
              </div>
              <div class="cyx-ask">
                <input type="text" maxlength="2000" placeholder="Ask Claude about this cycle - e.g. why does #81 still fail?" [value]="question()"
                       (input)="question.set($any($event.target).value)" (keydown.enter)="ask()" aria-label="Ask Claude about this cycle" />
                <button type="button" class="action-btn" [disabled]="!question().trim()" (click)="ask()">✦ Ask</button>
              </div>
              @if (asked()) { <div class="cyx-ok">Sent to the board chat, with this cycle.</div> }
            }
            @case ('story') {
              @if (story(); as st) {
                <div class="cyx-story">
                  @for (step of st; track $index) {
                    <details class="cyx-step" [class.fail]="step.failed" [open]="step.failed > 0">
                      <summary><b>{{ $index + 1 }} · {{ step.label }}</b>
                        <span class="cyx-dim">{{ time(step.points[0].at) }} · {{ step.points.length }} call(s)@if (step.failed) { · <span class="cyx-bad">{{ step.failed }} failed</span> }</span></summary>
                      @for (p of step.points; track p.callId) {
                        <div class="cyx-call" [class.fail]="p.failed">
                          <span>{{ time(p.at) }}</span><span>{{ p.method }} {{ p.path }}</span>
                          <span [class.cyx-bad]="p.failed">{{ p.status ?? 'error' }}</span><span>{{ ms(p.ms) }}</span>
                        </div>
                      }
                    </details>
                  } @empty { <div class="cyx-empty">No calls yet.</div> }
                  <div class="cyx-dim">Steps come from the cycle's spacers; without spacers, from pauses of more than 90 s. Open the cycle for each call's logs and SQL.</div>
                </div>
              } @else { <div class="cyx-dim">Loading…</div> }
            }
            @case ('calls') {
              @if (filter()) { <div class="cyx-dim">Showing {{ filter() }} · <button type="button" class="cyx-link" (click)="filter.set(null)">all calls</button></div> }
              <table class="cyx-table">
                <thead><tr><th>Time</th><th>Call</th><th>Status</th><th>ms</th></tr></thead>
                <tbody>
                  @for (p of shownCalls(); track p.callId) {
                    <tr><td>{{ time(p.at) }}</td><td>{{ p.method }} {{ p.path }}</td><td [class.cyx-bad]="p.failed">{{ p.status ?? 'error' }}</td><td>{{ ms(p.ms) }}</td></tr>
                  } @empty { <tr><td colspan="4" class="cyx-dim">No calls.</td></tr> }
                </tbody>
              </table>
              <a class="cyx-link" [routerLink]="['/cycles', c.id]">All calls, with bodies, logs and SQL →</a>
            }
            @case ('reqs') {
              @if (marks(); as m) {
                <div class="cyx-reqs">
                  @for (i of m; track i.fileName + i.key) {
                    <div><span [class]="'cyx-v ' + markTone(i)">{{ markWord(i) }}</span>{{ i.key }} <small class="cyx-dim">{{ i.fileName }}</small></div>
                  } @empty { <div class="cyx-empty">This board has no acceptance items yet.</div> }
                </div>
              } @else { <div class="cyx-dim">Loading…</div> }
            }
          }
        </div>
      }
    </div>`,
})
export class CycleRowComponent {
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly db = inject(DbCaptureApiService);
  private readonly chat = inject(ChatStateService);

  readonly cycle = input.required<SessionCycle>();
  readonly row = input.required<BoardCycleRow>();
  readonly summary = input<CycleSummary | null>(null);
  readonly marksIn = input<readonly ItemMark[] | null>(null, { alias: 'marks' });
  readonly found = input<readonly number[]>([]);
  readonly boardId = input.required<string>();
  readonly editable = input(true);
  readonly selected = input(false);
  readonly env = input<string | null>(null);
  readonly versus = input<string | null>(null);
  readonly hasBaseline = input(false);
  readonly pauseHint = input(false);
  readonly claudeSummaries = input(true);

  readonly selectedChange = output<boolean>();
  readonly action = output<CycleRowAction>();
  readonly cardTimeline = output<{ card: TestedCard; event: Event }>();
  readonly dismissPause = output<void>();
  readonly changed = output<SessionCycle>();

  readonly tabs = [{ key: 'overview', label: 'Overview' }, { key: 'story', label: 'Story' }, { key: 'calls', label: 'Calls' },
    { key: 'reqs', label: 'Requirements' }] as const;
  readonly open = signal(false);
  readonly tab = signal<'overview' | 'story' | 'calls' | 'reqs'>('overview');
  readonly menu = signal(false);
  readonly editing = signal(false);
  readonly draft = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly question = signal('');
  readonly asked = signal(false);
  readonly filter = signal<string | null>(null);
  readonly sql = signal<number | null>(null);
  private readonly spacers = signal<readonly CycleSpacer[] | null>(null);

  readonly marks = computed(() => this.marksIn());
  readonly acTotal = computed(() => this.marks()?.length ?? 0);
  readonly acMet = computed(() => (this.marks() ?? []).filter((m) => m.result === 'MEETS').length);
  readonly otherBoards = computed(() => this.row().otherBoards.length);
  readonly prose = computed(() => descriptionProse(this.cycle().description));
  readonly firstLine = computed(() => this.prose().split('\n')[0]);
  readonly steps = computed(() => parseSteps(this.cycle().description));
  readonly stepRows = computed(() => this.steps().map((step) => ({ step, state: stepState(step, this.summary()) })));
  readonly hot = computed(() => hotSpots(this.summary()));
  readonly when = computed(() => {
    const s = this.summary();
    if (!s?.firstAt) return null;
    const mins = s.lastAt ? Math.round((Date.parse(s.lastAt) - Date.parse(s.firstAt)) / 60000) : 0;
    return `${this.time(s.firstAt)}${mins > 0 ? ` · ${mins} min` : ''}`;
  });
  readonly spark = computed(() => (this.summary()?.strip ?? []).slice(-14).map((p) => ({ ...p, h: 5 + Math.min(9, Math.round(Math.log2(1 + (p.ms ?? 0) / 50))) })));
  readonly story = computed<StoryStep[] | null>(() => {
    const sp = this.spacers();
    const s = this.summary();
    return sp && s ? storySteps(s.strip, sp) : null;
  });
  readonly shownCalls = computed(() => {
    const all = this.summary()?.strip ?? [];
    const f = this.filter();
    return f ? all.filter((p) => `${p.method} ${p.path}` === f) : all;
  });

  tone(t: TestedCard): string {
    return verdictTone(t.verdict);
  }

  word(t: TestedCard): string {
    return (t.verdict === 'FAILS' ? '✗ ' : t.verdict === 'PASSES' ? '✓ ' : '? ') + verdictWord(t.verdict);
  }

  markTone(m: ItemMark): string {
    return m.result === 'MEETS' ? 'ok' : m.result === 'WRONG' || m.result === 'CONTRADICTS' ? 'bad' : 'unk';
  }

  markWord(m: ItemMark): string {
    return m.result === 'MEETS' ? '✓' : m.result === 'WRONG' || m.result === 'CONTRADICTS' ? '✗' : '?';
  }

  time(at: string | null | undefined): string {
    if (!at) return '';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  ms(v: number | null | undefined): string {
    if (v == null) return '—';
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  }

  act(a: CycleRowAction): void {
    this.menu.set(false);
    this.action.emit(a);
  }

  toggleOpen(event: Event): void {
    if ((event.target as HTMLElement).closest('a,button,input,textarea,.cyx-menu')) return;
    this.setOpen(!this.open());
  }

  /** Opened by click or Enter (the list's keys); loads what Overview shows the first time. */
  setOpen(on: boolean): void {
    this.open.set(on);
    if (on && this.sql() == null) {
      const ids = this.summary()?.inboundCallIds ?? [];
      if (ids.length) {
        this.db.summaries(ids.slice(0, 500)).subscribe({
          next: (m) => this.sql.set(Object.values(m).reduce((n, x) => n + (x.statementCount ?? 0), 0)),
          error: () => undefined,
        });
      }
    }
  }

  openTab(key: 'overview' | 'story' | 'calls' | 'reqs', filter: string | null = null): void {
    this.tab.set(key);
    this.filter.set(filter);
    if (key === 'story' && this.spacers() == null) {
      this.cyclesApi.listSpacers(this.cycle().id).subscribe({ next: (s) => this.spacers.set(s), error: () => this.spacers.set([]) });
    }
  }

  startEdit(): void {
    this.draft.set(this.cycle().description ?? '');
    this.error.set(null);
    this.editing.set(true);
  }

  saveDescription(): void {
    this.writeDescription(this.draft(), () => this.editing.set(false));
  }

  toggleStep(line: number, done: boolean): void {
    this.writeDescription(markStep(this.cycle().description ?? '', line, done));
  }

  private writeDescription(text: string, then?: () => void): void {
    this.saving.set(true);
    this.cyclesApi.putNotes(this.cycle().id, { description: text }).subscribe({
      next: (c) => { this.saving.set(false); this.changed.emit(c); then?.(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'Could not save the description'); },
    });
  }

  removeSummary(): void {
    this.cyclesApi.putNotes(this.cycle().id, { summary: '' }).subscribe({ next: (c) => this.changed.emit(c), error: () => undefined });
  }

  ask(): void {
    const q = this.question().trim();
    if (!q) return;
    const c = this.cycle();
    this.chat.send(this.boardId(), { text: `@[cycle:${c.id}|${c.name.replace(/[|\]]/g, ' ')}] ${q}` });
    this.question.set('');
    this.asked.set(true);
    setTimeout(() => this.asked.set(false), 4000);
  }
}
