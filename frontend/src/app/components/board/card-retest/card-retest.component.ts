import { SelectOption, SelectPickerComponent } from '../../select-picker/select-picker.component';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import {
  CardDetail, CardRetest, Expectation, ExpectationKind, RetestCheck, RetestOutcome, RetestStep, expectationText, implementedAndWorked, implementedChip,
  onlyEmptyAnswers, retestChip, suggestExpectations, workedChip,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { VerifyGuardService } from '../../../core/services/verify-guard.service';
import { ResendApiService } from '../../../core/services/resend-api.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';

const KIND_LABELS: Record<ExpectationKind, string> = {
  SQL_COUNT: 'SQL count ≤', STATUS: 'Status', NO_LOG: 'No log line at', DURATION: 'Duration ≤ (ms)', SAME_RESPONSE: 'Same response at',
};

/**
 * A card's re-test in its drawer (specs/016): what "fixed" means (expectations, editable, with suggestions), each one
 * before → after over the calls since the fix, the calls themselves, the steps, Replay the original call, the history,
 * and Accept Verified / Still wrong. Re-read whenever the drawer is (a "retest" signal bumps its version).
 */
@Component({
  selector: 'app-card-retest',
  standalone: true,
  imports: [SelectPickerComponent, MentionChipComponent],
  template: `
    @if (data(); as d) {
      <section class="board-card-retest">
        <h4>Re-test
          @if (chip(); as ch) { <span class="board-retest" [class]="'board-retest board-retest-' + ch.tone">{{ ch.text }}</span> }
          @if (editable() && card().status === 'FIXED') {
            <button type="button" class="board-link" title="Record a re-test of this card - its steps show on the strip" (click)="retest.emit()">▶ Re-test this card</button>
            <button type="button" class="board-link" title="Check the live calls since the fix now and keep it in the history" (click)="checkNow()">Check now</button>
          }
        </h4>
        @if (card().status === 'FIXED') {
          <!-- specs/026: two checks - implemented (the code, by Claude) and worked (the calls) - both before Verified -->
          <div class="board-vboxes">
            <div class="board-vbox" [class]="'board-vbox board-vcheck-' + impl().tone">
              <div class="board-vbox-h"><b>{{ impl().text }}</b>@if (d.check.code?.at; as at) { <span class="board-dim">by Claude · {{ when(at) }}</span> }</div>
              @if (d.check.code; as code) {
                <ul>
                  @if (code.commit) { <li>commit <code>{{ code.commit }}</code>@if (code.branch) { on <code>{{ code.branch }}</code> }</li> }
                  @for (l of code.layers; track $index) { <li [class.bad]="!l.ok">{{ l.ok ? '✓' : '✗' }} {{ l.team }}@if (l.where) { : {{ l.where }} }@if (l.note) { <span class="board-dim"> · {{ l.note }}</span> }</li> }
                  @if (code.tests) { <li>tests: {{ code.tests }}</li> }
                  @if (code.note) { <li class="board-dim">{{ code.note }}</li> }
                </ul>
              } @else {
                <div class="board-dim">Nobody checked the code since the fix: the commit on the task branch, in the running build, every layer.
                  <code>/alfred-verify {{ card().number }}</code> checks it.</div>
              }
            </div>
            <div class="board-vbox" [class]="'board-vbox board-vcheck-' + worked().tone">
              <div class="board-vbox-h"><b>{{ worked().text }}</b><span class="board-dim">{{ d.check.calls.length }} call{{ d.check.calls.length === 1 ? '' : 's' }} since the fix</span></div>
              <div class="board-dim">{{ worked().detail }}</div>
            </div>
          </div>
          @if (ready()) { <div class="board-vready">✓ Implemented and worked - ready for Verified</div> }
        }
        @if (d.check.statusOnly) {
          <div class="board-dim">No expectations yet - only the status is compared. Add what "fixed" means below.</div>
        }
        <div class="board-retest-table">
          <div class="board-retest-row head"><span></span><span>Check</span><span>before → now</span></div>
          @for (r of d.check.results; track $index) {
            <div class="board-retest-row">
              <span [class]="outcomeClass(r.outcome)">{{ outcomeIcon(r.outcome) }}</span>
              <span>{{ r.text }}@if (r.note) { <span class="board-dim"> · {{ r.note }}</span> }</span>
              <span class="board-retest-vals">
                @if (r.before !== null) { <span class="bad">{{ r.before }}</span> → }
                <span [class]="outcomeClass(r.outcome)">{{ r.after.length ? r.after.slice(0, 3).join(' · ') : '-' }}</span>
                @if (editable() && !d.check.statusOnly) {
                  <button type="button" class="board-link" title="Remove this expectation" (click)="removeExpectation($index)">✕</button>
                }
              </span>
            </div>
          }
        </div>
        @if (editable()) {
          <div class="board-retest-add">
            @for (s of suggestions(); track $index) {
              <button type="button" class="board-copy" title="Add this expectation" (click)="addExpectation(s)">+ {{ text(s) }}</button>
            }
            <app-select-picker class="select-compact" [options]="kindOptions" [value]="newKind()" ariaLabel="Expectation"
                               (valueChange)="newKind.set($any($event))" />
            @if (newKind() === 'SQL_COUNT') {
              <input class="board-retest-in" placeholder="table (blank = all)" #t /><input class="board-retest-in short" type="number" min="0" placeholder="max" #m />
              <button type="button" class="action-btn" (click)="addExpectation({ kind: 'SQL_COUNT', table: t.value || null, max: +m.value })">Add</button>
            } @else if (newKind() === 'STATUS') {
              <input class="board-retest-in short" placeholder="2xx, 200, !405" #r />
              <button type="button" class="action-btn" (click)="addExpectation({ kind: 'STATUS', range: r.value })">Add</button>
            } @else if (newKind() === 'NO_LOG') {
              <app-select-picker class="select-compact" [options]="logLevelOptions" [value]="noLogLevel()" ariaLabel="Log level"
                                 (valueChange)="noLogLevel.set($any($event))" />
              <button type="button" class="action-btn" (click)="addExpectation({ kind: 'NO_LOG', level: noLogLevel() })">Add</button>
            } @else if (newKind() === 'DURATION') {
              <input class="board-retest-in short" type="number" min="1" placeholder="ms" #ms />
              <button type="button" class="action-btn" (click)="addExpectation({ kind: 'DURATION', max: +ms.value, minCalls: 3 })">Add</button>
            } @else {
              <input class="board-retest-in" placeholder="$.countries.length" #p />
              <button type="button" class="action-btn" (click)="addExpectation({ kind: 'SAME_RESPONSE', path: p.value })">Add</button>
            }
          </div>
        }
        <h4>Calls since the fix <span class="board-dim">{{ d.check.calls.length }}</span>
          @if (original(); as o) {
            <button type="button" class="board-link" [title]="'Resend ' + o.label + ' - re-tests it with no clicking'" (click)="replay()">▶ Replay original call</button>
          }
        </h4>
        <div class="board-links">
          @for (c of d.check.calls; track c.ref) {
            <span class="board-retest-call" [class.bad]="!c.passed" [title]="c.failed ?? 'passes'">{{ c.passed ? '✓' : '✗' }}
              <app-mention-chip [mention]="{ type: 'call', ref: c.ref, label: c.label }" /></span>
          } @empty { <span class="board-dim">{{ d.check.newBuild ? 'New build running - nothing re-tested yet.' : 'No call to this endpoint since the fix.' }}</span> }
        </div>
        @if (d.check.beforeBuild) { <div class="board-dim">{{ d.check.beforeBuild }} calls before the app start that carries the fix - old code, not counted.</div> }
        @if (emptyOnly(d.check)) { <div class="board-retest-empty">⚠ Every answer was empty (0 rows) - the fix was not seen working on data.</div> }
        <h4>Re-test steps</h4>
        @for (s of d.check.steps; track $index) {
          <div class="board-retest-row"><span [class]="s.seen ? 'ok' : 'board-dim'">{{ s.seen ? '✓' : '○' }}</span><span>{{ s.text }}</span>
            <span class="board-retest-vals" [title]="s.note ?? ''">{{ s.seen ? s.calls + ' calls' : s.note ? 'called, request did not match' : 'not seen' }}
              @if (editable()) { <button type="button" class="board-link" title="Remove this step" (click)="removeStep($index)">✕</button> }</span></div>
        } @empty { <div class="board-dim">No steps - the card's own call is the re-test.</div> }
        @if (editable()) {
          <div class="board-retest-add">
            <input class="board-retest-in wide" placeholder="+ a step, e.g. Open the flight search page" #st (keydown.enter)="addStep(st.value); st.value = ''" />
          </div>
        }
        @if (d.history.length) {
          <h4>Re-test history</h4>
          @for (h of d.history; track h.id) {
            <div class="board-retest-row"><span [class]="h.verdict === 'PASSES' ? 'ok' : h.verdict === 'FAILS' ? 'bad' : 'board-dim'">{{ verdictIcon(h.verdict) }}</span>
              <span>{{ h.summary }} <span class="board-dim">· {{ h.source === 'live' ? 'live calls' : 'cycle' }} · {{ h.calls }} calls</span></span>
              <span class="board-retest-vals board-dim">{{ when(h.at) }}</span></div>
          }
        }
        @if (editable() && card().status === 'FIXED') {
          <div class="board-retest-foot">
            <button type="button" class="action-btn primary" [disabled]="d.check.verdict !== 'PASSES'"
                    [title]="ready() ? 'Implemented and worked' : d.check.verdict === 'PASSES' ? 'It worked - its code was not confirmed yet' : 'Not every check passes yet'"
                    (click)="move('VERIFIED')">✓ Accept Verified</button>
            <button type="button" class="action-btn" title="Back to To do - Claude picks it up again" (click)="move('TO_DO')">Still wrong…</button>
          </div>
        }
        @if (message()) { <div class="board-note">{{ message() }}</div> }
      </section>
    }`,
})
export class CardRetestComponent {
  private readonly api = inject(BoardApiService);
  private readonly verifyGuard = inject(VerifyGuardService);
  private readonly resend = inject(ResendApiService);
  private readonly confirm = inject(ConfirmDialogService);
  readonly card = input.required<CardDetail>();
  readonly version = input(0);
  readonly editable = input(true);
  readonly retest = output<void>();
  readonly data = signal<CardRetest | null>(null);
  readonly message = signal<string | null>(null);
  readonly newKind = signal<ExpectationKind>('SQL_COUNT');
  readonly kinds = Object.keys(KIND_LABELS) as ExpectationKind[];
  readonly kindLabels = KIND_LABELS;
  readonly kindOptions: readonly SelectOption[] = this.kinds.map((k) => ({ value: k, label: KIND_LABELS[k] }));
  readonly logLevelOptions: readonly SelectOption[] = [{ value: 'ERROR', label: 'ERROR' }, { value: 'WARN', label: 'WARN or ERROR' }];
  readonly noLogLevel = signal<'ERROR' | 'WARN'>('ERROR');

  readonly chip = computed(() => {
    const d = this.data();
    return d && d.check.verdict !== 'NOT_CHECKABLE' ? retestChip(d.check) : null;
  });
  readonly impl = computed(() => (this.data() ? implementedChip(this.data()!.check) : { text: '', detail: '', tone: 'wait' as const }));
  readonly worked = computed(() => (this.data() ? workedChip(this.data()!.check) : { text: '', detail: '', tone: 'wait' as const }));
  readonly ready = computed(() => implementedAndWorked(this.data()?.check));
  /** The verdict for the drawer's Re-test tab and its "needs you" row (specs/023). */
  readonly verdict = output<{ readonly text: string; readonly tone: 'pass' | 'fail' | 'part' | 'wait' } | null>();
  /** Suggested expectations not in the plan yet (FR-9). */
  readonly suggestions = computed(() => {
    const d = this.data();
    if (!d) return [];
    const have = new Set(d.plan.expectations.map((e) => expectationText(e)));
    return suggestExpectations(this.card()).filter((e) => !have.has(expectationText(e))).slice(0, 4);
  });
  /** The card's first live inbound call: what Replay resends. */
  readonly original = computed(() => this.card().links.find((m) => m.type.toLowerCase() === 'call' && m.ref.startsWith('in:')) ?? null);

  constructor() {
    effect(() => {
      const id = this.card().id;
      this.version();
      untracked(() => this.load(id));
    });
    effect(() => {
      const chip = this.chip();
      untracked(() => this.verdict.emit(chip));
    });
  }

  private load(id: string): void {
    this.api.cardRetest(id).subscribe({ next: (d) => this.data.set(d), error: () => this.data.set(null) });
  }

  text(e: Expectation): string {
    return expectationText(e);
  }

  outcomeIcon(o: RetestOutcome): string {
    return o === 'PASS' ? '✓' : o === 'FAIL' ? '✗' : o === 'WAITING' ? '…' : '?';
  }

  outcomeClass(o: RetestOutcome): string {
    return o === 'PASS' ? 'ok' : o === 'FAIL' ? 'bad' : 'board-dim';
  }

  verdictIcon(v: string): string {
    return v === 'PASSES' ? '✓' : v === 'FAILS' ? '✗' : v === 'FLAKY' ? '≈' : '○';
  }

  when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  addExpectation(e: Expectation): void {
    const d = this.data();
    if (!d) return;
    this.save([...d.plan.expectations, e], d.plan.steps);
  }

  removeExpectation(index: number): void {
    const d = this.data();
    if (!d) return;
    this.save(d.plan.expectations.filter((_, i) => i !== index), d.plan.steps);
  }

  addStep(text: string): void {
    const d = this.data();
    if (!d || !text.trim()) return;
    this.save(d.plan.expectations, [...d.plan.steps, { text: text.trim() }]);
  }

  removeStep(index: number): void {
    const d = this.data();
    if (!d) return;
    this.save(d.plan.expectations, d.plan.steps.filter((_, i) => i !== index));
  }

  private save(expectations: readonly Expectation[], steps: readonly RetestStep[]): void {
    this.api.setRetestPlan(this.card().id, expectations, steps).subscribe({
      next: () => {
        this.message.set(null);
        this.load(this.card().id);
      },
      error: (e) => this.message.set(messageOf(e)),
    });
  }

  checkNow(): void {
    const c = this.card();
    this.api.retestRun(c.project, [c.number], null).subscribe({
      next: (r) => {
        this.message.set(`Checked: ${r.checks[0]?.summary ?? 'nothing to check'}`);
        this.load(c.id);
      },
      error: (e) => this.message.set(messageOf(e)),
    });
  }

  async replay(): Promise<void> {
    const o = this.original();
    if (!o) return;
    const [id, cycleId] = o.ref.slice(3).split('@');
    const method = o.label.split(' ')[0]?.toUpperCase() ?? '';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const go = await this.confirm.confirm(`Replay ${o.label}? It is a ${method || 'write'} call - sending it again may change data in the app.`, 'Replay', 'Cancel');
      if (!go) return;
    }
    this.message.set('Replaying…');
    this.resend.resend({ direction: 'inbound', callId: id, cycleId: cycleId ?? null }).subscribe({
      next: (r) => this.message.set(`Replayed: ${r.status} in ${Math.round(r.durationMs)} ms - the check updates when its statements arrive.`),
      error: (e) => this.message.set(messageOf(e)),
    });
  }

  move(status: 'VERIFIED' | 'TO_DO'): void {
    const go = () => this.api.move(this.card().id, status).subscribe({ error: (e) => this.message.set(messageOf(e)) });
    if (status === 'VERIFIED') void this.verifyGuard.verify(this.card(), go);
    else go();
  }

  emptyOnly(c: RetestCheck): boolean {
    return onlyEmptyAnswers(c);
  }
}
