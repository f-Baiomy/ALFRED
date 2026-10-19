import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { auditTime, filter } from 'rxjs';
import { LinksApiService } from '../../../core/links/links-api.service';
import { LinksSocketService } from '../../../core/links/links-socket.service';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { EnvAsks, EnvBoard, EnvColumn, EnvMark, EnvStep } from '../../../core/links/links.models';
import { splitRef } from '../../../core/links/remote-ref';
import { BoardSocketService } from '../../../core/services/board-socket.service';

interface DraftEnv {
  name: string;
  linkId: string | null;
  required: boolean;
}

type Mark = EnvMark['mark'];

const EMPTY_ASKS: EnvAsks = { items: [], steps: [], fixedCards: [] };

/**
 * Every environment tests the same task (specs/035 D35-D41). On the host: the environments it names (Local = this
 * Alfred, STG = an Alfred the board is streamed to), one column each over the board's acceptance items, test steps and
 * Fixed cards' re-tests, read live from each Alfred, and the Overall over the required ones. On an environment Alfred
 * (the board streamed to it): its own column, which only it writes - marks with evidence, step ticks, a test cycle
 * recorded for the board, and the re-test of the Fixed cards on its own calls.
 */
@Component({
  selector: 'app-env-matrix',
  standalone: true,
  template: `
    @if (hostMode()) {
      <section class="tv-card env">
        <h4>Environments <small>every environment tests the same task - Overall needs each required one</small>
          @if (editable() && !editing()) { <button type="button" class="board-link" (click)="startEdit()">✎ Environments</button> }</h4>

        @if (editing()) {
          <div class="env-edit">
            @for (d of draft(); track $index; let i = $index) {
              <div class="lk-line">
                <input class="lk-in" type="text" maxlength="24" placeholder="e.g. STG" [value]="d.name" (input)="patch(i, { name: $any($event.target).value })" />
                <select class="lk-in" [value]="d.linkId ?? ''" (change)="patch(i, { linkId: $any($event.target).value || null })" aria-label="Filled by">
                  <option value="">This Alfred</option>
                  @for (l of streamedTo(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
                </select>
                <label class="lk-check"><input type="checkbox" [checked]="d.required" (change)="patch(i, { required: $any($event.target).checked })" /> required</label>
                <button type="button" class="board-link danger" (click)="removeEnv(i)">Remove</button>
              </div>
            }
            @if (!streamedTo().length) { <div class="lk-small lk-dim">Stream this board to an Alfred first (⇉ Stream…) to let it fill an environment.</div> }
            <div class="lk-row">
              <button type="button" class="board-link" (click)="addEnv()">＋ Environment</button>
              <span class="lk-sp"></span>
              <button type="button" class="action-btn" (click)="editing.set(false)">Cancel</button>
              <button type="button" class="action-btn primary" [disabled]="busy() || !draftValid()" (click)="saveEnvs()">Save</button>
            </div>
          </div>
        }

        @if (board(); as b) {
          @if (b.columns.length) {
            <div class="env-overall" [class]="'env-overall env-' + b.overall.toLowerCase()">
              Overall: <b>{{ overallWord(b.overall) }}</b>
              @if (b.failing.length) { <span> - fails on {{ b.failing.join(', ') }}</span> }
              @else if (b.waitingOn.length) { <span> - waiting on {{ b.waitingOn.join(', ') }}</span> }
            </div>
            <div class="env-scroll">
              <table class="lk-table env-table">
                <thead><tr><th></th>
                  @for (c of b.columns; track c.name) {
                    <th [title]="c.alfred + (c.error ? ' - ' + c.error : '')">{{ c.name }}@if (c.required) { <span class="lk-dim">*</span> }
                      <div class="lk-small lk-dim">{{ c.here ? 'here' : c.alfred }}@if (!c.here && !c.online) { · offline }</div></th>
                  }
                </tr></thead>
                <tbody>
                  @for (it of asks().items; track it.fileName + it.itemKey) {
                    <tr><td class="env-what">{{ it.text || it.itemKey }}</td>
                      @for (c of b.columns; track c.name) { <td [title]="markTitle(c, it.fileName, it.itemKey)">{{ markOf(c, it.fileName, it.itemKey) }}</td> }</tr>
                  }
                  @for (st of asks().steps; track st) {
                    <tr><td class="env-what">step · {{ st }}</td>
                      @for (c of b.columns; track c.name) { <td>{{ stepOf(c, st) }}</td> }</tr>
                  }
                  @for (n of asks().fixedCards; track n) {
                    <tr><td class="env-what">re-test #{{ n }}</td>
                      @for (c of b.columns; track c.name) { <td [title]="retestTitle(c, n)">{{ retestOf(c, n) }}</td> }</tr>
                  }
                  <tr class="env-verdicts"><td>Verdict</td>
                    @for (c of b.columns; track c.name) {
                      <td [class]="'env-' + c.verdict.toLowerCase()" [title]="c.missing.length ? 'Still: ' + c.missing.join(', ') : ''">{{ overallWord(c.verdict) }}</td>
                    }</tr>
                </tbody>
              </table>
            </div>
          } @else if (!editing()) {
            <div class="lk-small lk-dim">One environment: this Alfred. Name more (STG, UAT…) to have each Alfred test the same task.</div>
          }
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      </section>
    } @else {
      @if (mine(); as c) {
      <!-- this Alfred is an environment of another Alfred's board: its own column only -->
      <section class="tv-card env">
        <h4>🧪 {{ c.name }} <small>this Alfred's column of {{ hostName() }}'s board - only you write it; {{ hostName() }} sees it live</small></h4>
        <div class="env-overall" [class]="'env-overall env-' + c.verdict.toLowerCase()">{{ c.name }}: <b>{{ overallWord(c.verdict) }}</b>
          @if (c.missing.length) { <span class="lk-dim"> - still {{ c.missing.slice(0, 4).join(', ') }}@if (c.missing.length > 4) { … } </span> }</div>
        <label class="lk-check">Evidence for the next mark
          <input class="lk-in lk-wide" type="text" maxlength="2000" placeholder="e.g. the 500 on POST /refunds - optional" [value]="evidence()"
                 (input)="evidence.set($any($event.target).value)" /></label>
        <table class="lk-table env-table">
          <tbody>
            @for (it of c.asks.items; track it.fileName + it.itemKey) {
              <tr><td class="env-what">{{ it.text || it.itemKey }}</td>
                <td class="env-pick">
                  @for (m of marks; track m) {
                    <button type="button" class="lk-btn" [class.p]="markValue(c, it.fileName, it.itemKey) === m" [disabled]="busy()"
                            (click)="setMark(it.fileName, it.itemKey, m)">{{ markWord(m) }}</button>
                  }
                  @if (markValue(c, it.fileName, it.itemKey)) { <button type="button" class="board-link" (click)="clearMark(it.fileName, it.itemKey)">clear</button> }
                </td></tr>
            }
            @for (st of c.asks.steps; track st) {
              <tr><td class="env-what">step · {{ st }}</td>
                <td class="env-pick">
                  <button type="button" class="lk-btn" [class.p]="stepValue(c, st) === 'SEEN'" [disabled]="busy()" (click)="setStep(st, 'SEEN')">✓ seen</button>
                  <button type="button" class="lk-btn" [class.p]="stepValue(c, st) === 'FAILED'" [disabled]="busy()" (click)="setStep(st, 'FAILED')">✗ failed</button>
                  @if (stepValue(c, st)) { <button type="button" class="board-link" (click)="clearStep(st)">clear</button> }
                </td></tr>
            }
            @for (n of c.asks.fixedCards; track n) {
              <tr><td class="env-what">re-test #{{ n }}</td><td [title]="retestTitle(c, n)">{{ retestOf(c, n) || 'not re-tested here yet' }}</td></tr>
            }
          </tbody>
        </table>
        <div class="lk-row">
          <button type="button" class="action-btn primary" [disabled]="busy()" (click)="record()"
                  [title]="'A cycle on this Alfred, streamed to ' + hostName() + ' and put on its board as ' + c.name">● Record for {{ c.name }}</button>
          @if (c.asks.fixedCards.length) {
            <button type="button" class="action-btn" [disabled]="busy()" (click)="retestOpen.set(!retestOpen())">↻ Re-test cards for {{ c.name }}…</button>
          }
        </div>
        @if (retestOpen()) {
          <div class="env-retest">
            <div class="lk-small lk-dim">The Fixed cards are judged by {{ hostName() }}'s own re-test, on this Alfred's calls since each fix - only {{ c.name }}'s
              cycles count for its column.</div>
            @for (n of c.asks.fixedCards; track n) {
              <label class="lk-check"><input type="checkbox" [checked]="retestCards().includes(n)" (change)="toggleCard(n)" /> #{{ n }}</label>
            }
            <select class="lk-in" [value]="retestCycle()" (change)="retestCycle.set($any($event.target).value)" aria-label="Cycle">
              <option value="">every {{ c.name }} cycle</option>
              @for (cy of c.cycles; track cy.cycleRef) { <option [value]="cy.cycleRef">{{ cy.name || cy.cycleRef }}</option> }
            </select>
            <button type="button" class="action-btn primary" [disabled]="busy() || !retestCards().length" (click)="retest()">Re-test</button>
          </div>
        }
        @if (note()) { <div class="lk-small">{{ note() }}</div> }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      </section>
      }
    }`,
  styles: [`
    .env { margin-top: .8rem; }
    .env-edit { display: grid; gap: .25rem; margin: .4rem 0 .6rem; }
    .env-overall { margin: .3rem 0 .5rem; font-size: .85rem; }
    .env-pass, .env-overall.env-pass b { color: var(--green); }
    .env-fail, .env-overall.env-fail b { color: var(--red); }
    .env-waiting, .env-overall.env-waiting b { color: var(--amber); }
    .env-scroll { overflow-x: auto; }
    .env-table td:not(.env-what) { text-align: center; white-space: nowrap; }
    .env-table td.env-pick { text-align: left; }
    .env-what { max-width: 420px; overflow-wrap: anywhere; }
    .env-verdicts td { font-weight: 600; border-top: 2px solid var(--border); }
    .env-pick { display: flex; gap: .3rem; flex-wrap: wrap; align-items: center; }
    .env-retest { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: .5rem; }
  `],
})
export class EnvMatrixComponent {
  private readonly api = inject(LinksApiService);
  private readonly links = inject(LinksStateService);

  /** The board as this page has it: this Alfred's own, or another's (`<id>@<slug>`). */
  readonly boardId = input.required<string>();
  readonly boardName = input<string | null>(null);
  readonly project = input('');
  readonly editable = input(true);

  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly board = signal<EnvBoard | null>(null);
  readonly mine = signal<EnvColumn | null>(null);
  readonly editing = signal(false);
  readonly draft = signal<DraftEnv[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly note = signal<string | null>(null);
  readonly retestOpen = signal(false);
  readonly retestCards = signal<number[]>([]);
  readonly retestCycle = signal('');
  readonly evidence = signal('');

  private readonly split = computed(() => splitRef(this.boardId()));
  /** This Alfred's own board: it names the environments and shows every column. */
  readonly hostMode = computed(() => this.split() === null);
  readonly hostName = computed(() => this.links.nameOf(this.split()?.slug));
  readonly asks = computed(() => this.board()?.asks ?? EMPTY_ASKS);
  /** The Alfreds this board is streamed to - the only ones that may fill an environment (D35). */
  readonly streamedTo = computed(() => {
    const ids = new Set(this.links.streamsOf('BOARD', this.boardId()).map((s) => s.linkId));
    return this.links.links().filter((l) => ids.has(l.id));
  });
  readonly draftValid = computed(() => {
    const names = this.draft().map((d) => d.name.trim().toUpperCase());
    return names.every((n) => /^[A-Z0-9][A-Z0-9 _-]{0,23}$/.test(n)) && new Set(names).size === names.length;
  });

  constructor() {
    this.links.start();
    effect(() => {
      this.boardId();
      untracked(() => this.load());
    });
    // live: an environment marked something, a link came back, the board's requirements changed - never a timer
    const subs = [
      inject(LinksSocketService).events$.pipe(
        filter((e) => e.type === 'env-changed' || e.type === 'links-changed' || (e.type === 'signal' && (e.channel === 'env' || e.channel === 'resync'))),
        auditTime(600)).subscribe(() => this.load()),
      inject(BoardSocketService).events$.pipe(filter((e) => e.type === 'board-changed'), auditTime(1500)).subscribe(() => this.load()),
    ];
    inject(DestroyRef).onDestroy(() => subs.forEach((s) => s.unsubscribe()));
  }

  load(): void {
    const id = this.boardId();
    const split = this.split();
    if (!split) {
      this.api.envBoard(id).subscribe({ next: (b) => this.boardId() === id && this.board.set(b), error: () => this.board.set(null) });
      return;
    }
    // another Alfred's board: a column only when it named this Alfred one of its environments
    const assigned = () => this.links.linkOf(split.slug);
    if (!assigned()) return;
    this.api.myColumn(split.slug, split.inner).subscribe({ next: (c) => this.boardId() === id && this.mine.set(c), error: () => this.mine.set(null) });
  }

  // ------------------------------------------------------------------------------------------------------- host
  startEdit(): void {
    const b = this.board();
    this.draft.set((b?.columns ?? []).map((c) => ({ name: c.name, linkId: c.linkId, required: c.required })));
    if (!this.draft().length) this.draft.set([{ name: 'LOCAL', linkId: null, required: true }]);
    this.editing.set(true);
  }

  patch(i: number, p: Partial<DraftEnv>): void {
    this.draft.update((list) => list.map((d, j) => (j === i ? { ...d, ...p } : d)));
  }

  addEnv(): void {
    this.draft.update((list) => [...list, { name: '', linkId: this.streamedTo()[0]?.id ?? null, required: true }]);
  }

  removeEnv(i: number): void {
    this.draft.update((list) => list.filter((_, j) => j !== i));
  }

  saveEnvs(): void {
    this.busy.set(true);
    this.error.set(null);
    const envs = this.draft().map((d) => ({ name: d.name.trim().toUpperCase(), linkId: d.linkId, required: d.required }));
    this.api.setEnvs(this.boardId(), this.boardName() ?? this.boardId(), this.project(), envs).subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(false);
        this.load();
      },
      error: (e) => this.fail(e),
    });
  }

  markOf(c: EnvColumn, fileName: string, itemKey: string): string {
    const m = c.marks.find((x) => x.fileName === fileName && x.itemKey === itemKey);
    if (!c.here && !c.online) return '…';
    return m ? this.markWord(m.mark) : '·';
  }

  markTitle(c: EnvColumn, fileName: string, itemKey: string): string {
    const m = c.marks.find((x) => x.fileName === fileName && x.itemKey === itemKey);
    return m ? `${m.mark} by ${m.actor}${m.evidence ? ' - ' + m.evidence : ''}` : c.here || c.online ? 'not marked' : `${c.alfred} is offline`;
  }

  stepOf(c: EnvColumn, step: string): string {
    if (!c.here && !c.online) return '…';
    const s = c.steps.find((x) => x.stepKey === step);
    return s ? (s.state === 'SEEN' ? '✓' : '✗') : '·';
  }

  retestOf(c: EnvColumn, card: number): string {
    const r = c.retests.find((x) => x.cardNumber === card);
    return r ? (r.verdict === 'PASS' ? '✓' : r.verdict === 'FAIL' ? '✗' : '?') : c.here || c.online ? '·' : '…';
  }

  retestTitle(c: EnvColumn, card: number): string {
    const r = c.retests.find((x) => x.cardNumber === card);
    return r ? `${r.verdict}${r.summary ? ' - ' + r.summary : ''}` : '';
  }

  markWord(m: Mark | string): string {
    return m === 'PASS' ? '✓ pass' : m === 'FAIL' ? '✗ fail' : '? can\'t tell';
  }

  overallWord(v: string): string {
    return v === 'PASS' ? 'passes' : v === 'FAIL' ? 'fails' : v === 'NONE' ? 'no required environment' : 'waiting';
  }

  // ----------------------------------------------------------------------------------------- environment Alfred
  markValue(c: EnvColumn, fileName: string, itemKey: string): Mark | null {
    return c.marks.find((x) => x.fileName === fileName && x.itemKey === itemKey)?.mark ?? null;
  }

  stepValue(c: EnvColumn, step: string): EnvStep['state'] | null {
    return c.steps.find((x) => x.stepKey === step)?.state ?? null;
  }

  setMark(fileName: string, itemKey: string, mark: Mark): void {
    const s = this.split();
    if (!s) return;
    const evidence = this.evidence().trim();
    this.run(this.api.envMark(s.slug, s.inner, fileName, itemKey, mark, evidence), () => {
      this.evidence.set('');
      return '';
    });
  }

  clearMark(fileName: string, itemKey: string): void {
    const s = this.split();
    if (s) this.run(this.api.clearEnvMark(s.slug, s.inner, fileName, itemKey));
  }

  setStep(step: string, state: 'SEEN' | 'FAILED'): void {
    const s = this.split();
    if (s) this.run(this.api.envStep(s.slug, s.inner, step, state));
  }

  clearStep(step: string): void {
    const s = this.split();
    if (s) this.run(this.api.clearEnvStep(s.slug, s.inner, step));
  }

  record(): void {
    const s = this.split();
    if (!s) return;
    this.run(this.api.envRecord(s.slug, s.inner, null, []), (c) => `Recording "${(c as { name?: string }).name ?? 'a test cycle'}" - streamed to ${this.hostName()}, on its board.`);
  }

  toggleCard(n: number): void {
    this.retestCards.update((list) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b)));
  }

  retest(): void {
    const s = this.split();
    if (!s) return;
    const cycle = this.retestCycle() ? splitRef(this.retestCycle())?.inner ?? this.retestCycle() : null;
    this.run(this.api.envRetest(s.slug, s.inner, this.retestCards(), cycle), (list) => {
      const r = list as { cardNumber: number; verdict: string }[];
      this.retestOpen.set(false);
      return r.map((x) => `#${x.cardNumber} ${x.verdict.toLowerCase()}`).join(' · ') || 'Re-tested.';
    });
  }

  private run<T>(o: import('rxjs').Observable<T>, say?: (v: T) => string): void {
    this.busy.set(true);
    this.error.set(null);
    o.subscribe({
      next: (v) => {
        this.busy.set(false);
        if (say) this.note.set(say(v) || null);
        this.load();
      },
      error: (e) => this.fail(e),
    });
  }

  private fail(e: unknown): void {
    this.busy.set(false);
    const p = problemOf(e);
    this.error.set(p.message || p.error);
  }
}

