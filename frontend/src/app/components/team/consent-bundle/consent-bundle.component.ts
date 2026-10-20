import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AzureEvidenceService } from '../../../core/team/azure-evidence.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { BundleCheck, StepCheck, StepKind, WriteBundle, WriteStep } from '../../../core/team/team.models';
import { DiffPart, changedText, textDiff } from '../../../shared/utils/text-diff';
import { MarkdownViewComponent } from '../../board/markdown-view/markdown-view.component';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { ReviewRow, azureCheck, createRows, editRows, isEdit, wideReasons } from '../../../core/team/bundle-review';

const WORDS: Record<StepKind, string> = {
  STATE: 'State', COMMENT: 'Comment', ATTACH: 'Attach', HYPERLINK: 'Link back to Alfred', UNHYPERLINK: 'Remove the link to Alfred',
  TAG: 'Tag', UNTAG: 'Remove the tag', CREATE: 'Create', LINK_ALFRED: 'Link in Alfred', FIELD: 'Field',
};

/** Seconds between Approve and the send, with Undo (specs/034). */
export const UNDO_SECONDS = 5;

/** A bundle older than this says how long it has waited (in the review only - never a reminder). */
const OLD_MS = 12 * 3600_000;

/**
 * One consent bundle as a review (specs/028 US4, specs/034): every write to the tracker Claude or Alfred prepared, each
 * change read as old -> new - a state or field with the item's value now (read live when the review opens, so a move
 * someone made since, or one Azure would refuse, shows before Approve), a comment with what the user changed against
 * Claude's draft (or what Claude changed in a redraft), raw or as Azure will show it. Approve sends after a 5 s Undo;
 * Reject takes an optional reason for Claude; a step that failed can be sent again alone. The same review serves the
 * board header's tray, the chat, the card's strip and its Links tab. Nothing is sent before Approve, and only the user
 * approves.
 */
@Component({
  selector: 'app-team-consent-bundle',
  standalone: true,
  imports: [FormsModule, DatePipe, MarkdownViewComponent],
  template: `
    @if (b(); as w) {
      <div class="tcb" [class]="'tcb tcb-' + w.state" [class.tcb-active]="active()" [class.tcb-compact]="compact()">
        <div class="tcb-head">
          @if (cardNumber()) { <span class="tcb-card">#{{ cardNumber() }}</span> }
          <b class="tcb-title">{{ w.item ? 'AB#' + w.item + ' · ' : '' }}{{ w.title }}</b>
          <span class="tcb-dim">{{ origin(w) }} · {{ w.createdAt | date: 'MMM d, HH:mm' }}</span>
          @if (waitingLong()) { <span class="tcb-dim">· waiting since {{ w.createdAt | date: 'EEE HH:mm' }}</span> }
          <span class="tcb-grow"></span>
          @switch (w.state) {
            @case ('DONE') { <span class="tcb-sent">✓ Sent {{ w.decidedAt | date: 'HH:mm' }} by you</span> }
            @case ('PARTIAL') { <span class="tcb-sent err">Partly sent {{ w.decidedAt | date: 'HH:mm' }}</span> }
            @case ('SENDING') { <span class="tcb-dim">Sending…</span> }
            @case ('REJECTED') { <span class="tcb-dim">✗ Rejected {{ w.decidedAt | date: 'HH:mm' }}</span> }
          }
          @if (azureUrl(); as u) { <a class="board-link" [href]="u" target="_blank" rel="noopener">open in Azure ↗</a> }
          @if (showOpen() && w.cardId) { <button type="button" class="board-link" (click)="openCard.emit(w.cardId!)">Open card</button> }
        </div>
        @if (w.state === 'REJECTED' && w.note) { <div class="tcb-dim">Your reason: <i>{{ w.note }}</i></div> }

        @for (s of steps(); track $index; let i = $index) {
          <div class="tcb-step" [class.off]="!s.ticked">
            @if (open()) {
              <input type="checkbox" [checked]="s.ticked" [disabled]="!editable() || counting()" (change)="tick(i, $any($event.target).checked)"
                     [attr.aria-label]="'Send: ' + word(s.kind)" />
            } @else {
              <span class="tcb-res-icon" [class.err]="s.result && !s.result.ok">{{ !s.ticked ? '·' : !s.result ? '…' : s.result.ok ? '✓' : '✗' }}</span>
            }
            <span class="tcb-k">{{ word(s.kind) }}@if (s.payload['item'] && s.payload['item'] !== w.item) { <span class="tcb-dim">AB#{{ s.payload['item'] }}</span> }
              @if (s.kind === 'COMMENT' && userEdited(s)) { <span class="tcb-edited">edited by you</span> }
              @if (s.kind === 'COMMENT' && redrafted(s)) { <span class="tcb-edited claude">✦ redrafted</span> }
            </span>
            <div class="tcb-body">
              @switch (s.kind) {
                @case ('STATE') {
                  @if (editing() === i) {
                    <input [ngModel]="s.payload['state']" (ngModelChange)="edit(i, 'state', $event)" [name]="'s' + i" />
                  } @else {
                    <span class="tcb-chg">
                      @if (oldOf(s, i); as o) { <span class="tcb-old">{{ o }}</span><span class="tcb-arrow">→</span> }
                      <span class="tcb-new">{{ s.payload['state'] }}</span>
                      @if (open() && editable()) { <button type="button" class="board-link" (click)="editing.set(i)">✎</button> }
                    </span>
                  }
                  @if (checkOf(i); as c) {
                    @if (c.changed) {
                      <div class="tcb-warn">⟳ Azure says <b>{{ c.now }}</b> now - it was <b>{{ s.payload['from'] }}</b> when this was drafted
                        @if (check()?.changedBy) { (changed {{ check()!.changedAt | date: 'MMM d, HH:mm' }} by {{ check()!.changedBy }}) }</div>
                    }
                    @if (c.refused) {
                      <div class="tcb-warn bad">⛔ Azure does not allow {{ c.now }} → {{ s.payload['state'] }} for this item.
                        @if (c.allowed?.length) { Allowed from {{ c.now }}:
                          @for (a of c.allowed; track a) { <button type="button" class="board-link" [disabled]="!open() || !editable()" (click)="pickState(i, a)">{{ a }}</button> }
                        } Left out unless you tick it.</div>
                    }
                  }
                }
                @case ('FIELD') {
                  @if (isEdit(s)) {
                    <!-- specs/038 FR-4: every change of the edit, before -> after -->
                    <table class="tcb-rows">
                      @for (r of editRows(s, i); track r.label) {
                        <tr><th>{{ r.label }}</th><td class="tcb-chg">
                          @if (r.before !== null) { <span class="tcb-old">{{ r.before }}</span><span class="tcb-arrow">→</span> }
                          <span class="tcb-new">{{ r.after }}</span></td></tr>
                      }
                    </table>
                    @if (checkOf(i)?.changed) { <div class="tcb-warn">⟳ Something here changed in Azure since this was drafted - the "before" values are Azure's now</div> }
                  } @else {
                  <span class="tcb-chg">{{ s.payload['field'] }}
                    @if (oldOf(s, i) !== null) { <span class="tcb-old">{{ oldOf(s, i) || '(empty)' }}</span><span class="tcb-arrow">→</span> }
                    @if (editing() === i) { <input [ngModel]="s.payload['value']" (ngModelChange)="edit(i, 'value', $event)" [name]="'f' + i" /> }
                    @else {
                      <span class="tcb-new">{{ s.payload['value'] || '(cleared)' }}</span>
                      @if (open() && editable()) { <button type="button" class="board-link" (click)="editing.set(i)">✎</button> }
                    }
                  </span>
                  @if (checkOf(i)?.changed) { <div class="tcb-warn">⟳ Azure says <b>{{ checkOf(i)!.now || '(empty)' }}</b> now - it changed since this was drafted</div> }
                  }
                }
                @case ('COMMENT') {
                  @if (editing() === i) {
                    <textarea rows="5" [ngModel]="s.payload['text']" (ngModelChange)="edit(i, 'text', $event)" [name]="'t' + i"></textarea>
                    <div class="tcb-line"><button type="button" class="board-link" (click)="editing.set(null)">Done</button></div>
                  } @else if (preview().has(i)) {
                    <div class="tcb-azure"><app-markdown-view [text]="(s.payload['text'] || '') + footer()" [previews]="false" /></div>
                  } @else {
                    <div class="tcb-text">@for (p of diffOf(s); track $index) {<span [class]="'tcb-d-' + p.kind">{{ p.text }}</span>}</div>
                    @if (draftShown().has(i) && s.payload['draft']) { <div class="tcb-text tcb-draft"><span class="tcb-dim">Claude's draft:</span> {{ s.payload['draft'] }}</div> }
                  }
                  <div class="tcb-line">
                    <span class="tcb-seg">
                      <button type="button" [class.on]="!preview().has(i)" (click)="setPreview(i, false)">Raw</button>
                      <button type="button" [class.on]="preview().has(i)" (click)="setPreview(i, true)">Azure preview</button>
                    </span>
                    @if (open() && editable() && editing() !== i) { <button type="button" class="board-link" (click)="editing.set(i); setPreview(i, false)">✎ Edit</button> }
                    @if (s.payload['draft'] && userEdited(s)) {
                      <button type="button" class="board-link" (click)="toggleDraft(i)">{{ draftShown().has(i) ? "Hide Claude's draft" : "Show Claude's draft" }}</button>
                    }
                    @if (open() && editable() && redrafted(s) && s.payload['draft'] && s.payload['draft'] !== s.payload['text']) {
                      <button type="button" class="board-link" (click)="edit(i, 'text', s.payload['draft'])">back to the first draft</button>
                    }
                    <span class="tcb-dim">posts as you</span>
                  </div>
                  @if (open() && editable() && canRedraft()) {
                    <div class="tcb-line">
                      <input class="tcb-ask" [ngModel]="asks()[i] ?? ''" (ngModelChange)="setAsk(i, $event)" [name]="'a' + i" maxlength="2000"
                             placeholder="Ask Claude to change it - e.g. shorter, mention build 3.4.7" (keydown.enter)="redraft(i)" />
                      <button type="button" class="action-btn" [disabled]="!(asks()[i] ?? '').trim() || busy()" (click)="redraft(i)">✦ Redraft</button>
                    </div>
                  }
                }
                @case ('ATTACH') {
                  <span>📎 {{ s.payload['name'] }}@if (s.payload['size']) { · {{ kb(s.payload['size']) }} KB } · {{ s.unmasked ? 'unmasked' : 'secrets masked' }}</span>
                  @if (open() && editable()) {
                    <label class="tcb-tick" title="Masks nothing - not even Authorization or cookies"><input type="checkbox" [checked]="s.unmasked"
                           (change)="unmask(i, $any($event.target).checked)" /> send unmasked</label>
                    <button type="button" class="action-btn" [disabled]="building() === i" (click)="build(i)">{{ building() === i ? 'Building…' : built()[i] || s.payload['built'] ? 'Rebuild' : 'Build the file' }}</button>
                    @if (built()[i]) { <span class="tcb-dim">{{ built()[i] }}</span> }
                  }
                }
                @case ('CREATE') {
                  <span class="tcb-new">+ {{ s.payload['type'] }}: {{ s.payload['title'] }}</span>
                  <table class="tcb-rows">
                    @for (r of createRows(s); track r.label + r.after) { <tr><th>{{ r.label }}</th><td>{{ r.after }}</td></tr> }
                  </table>
                  @if (s.payload['description']) {
                    <details class="tcb-desc"><summary>Description</summary><app-markdown-view [text]="s.payload['description']" [previews]="false" /></details>
                  }
                }
                @case ('TAG') { <span class="tcb-new">+ {{ s.payload['tag'] }}</span> }
                @case ('UNTAG') { <span class="tcb-old">{{ s.payload['tag'] }}</span> }
                @default { <span class="tcb-dim">{{ payloadText(s) }}</span> }
              }
              @if (open() && azureCheck(s); as ac) { <div class="tcb-check" [class]="'tcb-check tcb-check-' + ac.tone">{{ ac.text }}</div> }
              @if (s.result; as r) {
                <div class="tcb-res" [class.err]="!r.ok">{{ r.ok ? '✓ ' + (r.message || 'sent') : '✗ ' + (r.message || 'failed') }}
                  @if (!r.ok && w.state === 'PARTIAL' && editable()) { <button type="button" class="action-btn" [disabled]="busy()" (click)="retry(i)">Retry this step</button> }
                </div>
              }
            </div>
          </div>
        }

        @if (open() && editable()) {
          <div class="tcb-acts">
            @if (counting(); as left) {
              <span>Sending in <b>{{ left }} s</b>…</span>
              <span class="tcb-bar"><span [style.width.%]="(left / undoSeconds) * 100"></span></span>
              <button type="button" class="action-btn" (click)="undo()">Undo</button>
            } @else if (rejecting()) {
              <input class="tcb-ask" [ngModel]="reason()" (ngModelChange)="reason.set($event)" name="reason" maxlength="1000"
                     placeholder="Why? (optional - Claude reads it)" (keydown.enter)="reject()" (keydown.escape)="rejecting.set(false)" />
              <button type="button" class="action-btn" [disabled]="busy()" (click)="reject()">Reject</button>
              <button type="button" class="board-link" (click)="rejecting.set(false)">Cancel</button>
            } @else {
              <button type="button" class="action-btn primary" [disabled]="busy() || !ticked()" (click)="approve()">Approve {{ ticked() }} change{{ ticked() === 1 ? '' : 's' }}</button>
              <button type="button" class="action-btn" [disabled]="busy()" (click)="rejecting.set(true)">Reject</button>
              @if (dirty()) { <button type="button" class="action-btn" [disabled]="busy()" (click)="save()">Save changes</button> }
              @if (!state.hasToken()) { <span class="tcb-dim">Needs a live token to send - enter it on the Team tab.</span> }
              @else if (ticked() < steps().length) { <span class="tcb-dim">unticked changes are left out</span> }
            }
          </div>
        }
        @if (message()) { <div class="tcb-msg" [class.err]="isError()">{{ message() }}</div> }
      </div>
    }`,
})
export class TeamConsentBundleComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly evidence = inject(AzureEvidenceService);
  private readonly confirm = inject(ConfirmDialogService);

  readonly bundle = input.required<WriteBundle>();
  readonly editable = input(true);
  /** The card's number, shown as a pill (tray, chat). */
  readonly cardNumber = input<number | null>(null);
  /** An "Open card" link (the tray). */
  readonly showOpen = input(false);
  /** Shorter comments (the chat). */
  readonly compact = input(false);
  /** The tray's keyboard selection. */
  readonly active = input(false);
  readonly changed = output<WriteBundle>();
  readonly openCard = output<string>();

  readonly undoSeconds = UNDO_SECONDS;
  private readonly edited = signal<{ id: number; steps: WriteStep[] } | null>(null);
  readonly b = computed(() => this.bundle());
  readonly steps = computed(() => (this.edited()?.id === this.bundle().id ? this.edited()!.steps : this.bundle().steps));
  readonly dirty = computed(() => this.edited()?.id === this.bundle().id);
  readonly open = computed(() => this.bundle().state === 'WAITING');
  readonly ticked = computed(() => this.steps().filter((s) => s.ticked).length);
  readonly busy = signal(false);
  readonly building = signal<number | null>(null);
  readonly built = signal<Record<number, string>>({});
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  readonly check = signal<BundleCheck | null>(null);
  readonly editing = signal<number | null>(null);
  readonly preview = signal<ReadonlySet<number>>(new Set());
  readonly draftShown = signal<ReadonlySet<number>>(new Set());
  readonly asks = signal<Record<number, string>>({});
  readonly rejecting = signal(false);
  readonly reason = signal('');
  readonly counting = signal<number | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkedFor: number | null = null;

  readonly footer = computed(() => this.check()?.footer ?? '\n\n_via Alfred_');
  readonly waitingLong = computed(() => this.open() && Date.now() - Date.parse(this.bundle().createdAt) > OLD_MS);
  readonly canRedraft = computed(() => this.bundle().origin !== 'USER' && !!this.bundle().boardId);
  readonly azureUrl = computed(() => {
    const w = this.bundle();
    const conn = this.state.connections().find((c) => c.id === w.conn);
    return conn && w.item && conn.kind === 'azure' ? `${conn.baseUrl.replace(/\/+$/, '')}/_workitems/edit/${encodeURIComponent(w.item)}` : null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
    // read what the bundle meets in Azure once per bundle, when it opens with a token there
    effect(() => {
      const w = this.bundle();
      const live = this.state.hasToken();
      if (w.state !== 'WAITING' || !live || (!w.item && !w.steps.some((s) => s.payload['item'])) || this.checkedFor === w.id) return;
      if (!w.steps.some((s) => s.kind === 'STATE' || s.kind === 'FIELD' || s.kind === 'COMMENT')) return;
      this.checkedFor = w.id;
      untracked(() => this.runCheck(w.id));
    }, { allowSignalWrites: true });
  }

  private runCheck(id: number): void {
    this.api.checkBundle(id).subscribe({
      next: (c) => {
        this.check.set(c ?? null);
        if (!c) return;
        // a move Azure would refuse is left out until the user ticks it again
        const refused = c.steps.filter((s) => s.refused && this.steps()[s.step]?.ticked);
        if (refused.length && this.editable()) {
          for (const s of refused) this.tick(s.step, false);
        }
      },
      error: () => this.check.set(null), // no token, the tunnel, or the tracker is away: the bundle reads as it was made
    });
  }

  word(k: StepKind): string {
    return WORDS[k] ?? k;
  }

  origin(w: WriteBundle): string {
    return w.origin === 'CLAUDE' ? '✦ Claude' : w.origin === 'ALFRED' ? 'Alfred prepared it' : 'yours';
  }

  payloadText(s: WriteStep): string {
    return Object.entries(s.payload).filter(([k]) => !['from', 'draft', 'previous', 'redraftedAt', 'azureCheck', 'checkedAt', 'item'].includes(k))
      .map(([k, v]) => `${k}: ${v}`).join(' · ');
  }

  readonly isEdit = isEdit;
  readonly createRows = createRows;
  readonly azureCheck = azureCheck;

  /** An edit's rows, its "before" values Azure's now when the review read them (specs/038). */
  editRows(s: WriteStep, i: number): ReviewRow[] {
    return editRows(s, this.checkOf(i)?.now ?? null);
  }

  kb(size: string): number {
    return Math.max(1, Math.round(Number(size) / 1024));
  }

  checkOf(i: number): StepCheck | null {
    return this.check()?.steps.find((s) => s.step === i) ?? null;
  }

  /** The value before: Azure's now when read, else what the item had when the step was made; null when not known. */
  oldOf(s: WriteStep, i: number): string | null {
    const c = this.checkOf(i);
    if (c) return c.now;
    return s.payload['from'] ?? null;
  }

  userEdited(s: WriteStep): boolean {
    const d = s.payload['draft'];
    return d !== undefined && !this.redrafted(s) && d !== (s.payload['text'] ?? '');
  }

  redrafted(s: WriteStep): boolean {
    return s.payload['previous'] !== undefined && s.payload['previous'] !== s.payload['text'];
  }

  /** The comment as words: what Claude's redraft changed, or what the user changed against Claude's draft, else plain. */
  diffOf(s: WriteStep): DiffPart[] {
    const text = s.payload['text'] ?? '';
    const before = this.redrafted(s) ? s.payload['previous'] : this.userEdited(s) ? s.payload['draft'] : undefined;
    if (before === undefined) return [{ kind: 'same', text }];
    const parts = textDiff(before, text);
    return changedText(parts) ? parts : [{ kind: 'same', text }];
  }

  setPreview(i: number, on: boolean): void {
    this.preview.update((p) => toggle(p, i, on));
  }

  toggleDraft(i: number): void {
    this.draftShown.update((p) => toggle(p, i, !p.has(i)));
  }

  setAsk(i: number, v: string): void {
    this.asks.update((a) => ({ ...a, [i]: v }));
  }

  private change(i: number, f: (s: WriteStep) => WriteStep): void {
    const steps = this.steps().map((s, j) => (j === i ? f({ ...s, payload: { ...s.payload } }) : s));
    this.edited.set({ id: this.bundle().id, steps });
  }

  tick(i: number, on: boolean): void {
    this.change(i, (s) => ({ ...s, ticked: on }));
  }

  edit(i: number, key: string, value: string): void {
    this.change(i, (s) => ({ ...s, payload: { ...s.payload, [key]: value } }));
  }

  pickState(i: number, state: string): void {
    this.change(i, (s) => ({ ...s, ticked: true, payload: { ...s.payload, state } }));
    this.check.update((c) => c && { ...c, steps: c.steps.map((x) => (x.step === i ? { ...x, refused: false } : x)) });
  }

  unmask(i: number, on: boolean): void {
    this.change(i, (s) => ({ ...s, unmasked: on }));
    this.built.update((b) => ({ ...b, [i]: '' }));
  }

  private say(m: string, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  save(then?: () => void): void {
    const e = this.edited();
    if (!e) {
      then?.();
      return;
    }
    this.busy.set(true);
    this.api.editBundle(e.id, { steps: e.steps }).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.edited.set(null);
        this.editing.set(null);
        this.changed.emit(w);
        then?.();
      },
      error: (err) => {
        this.busy.set(false);
        this.say(err?.error?.message || 'Could not save the changes', true);
      },
    });
  }

  async build(i: number): Promise<void> {
    const s = this.steps()[i];
    const card = this.bundle().cardId;
    if (!card) return this.say('This bundle is on no card: there are no calls to build the file from', true);
    if (s.payload['card'] && s.payload['card'] !== card) return this.say('This attachment names another card - reject the bundle', true);
    this.building.set(i);
    try {
      const r = await this.evidence.build(card, s.unmasked);
      this.save(() => this.api.bundleFile(this.bundle().id, i, s.payload['name'] || 'evidence.html', r.blob).subscribe({
        next: (w) => {
          this.building.set(null);
          this.built.update((b) => ({ ...b, [i]: `${r.calls} call(s), ${Math.round(r.blob.size / 1024)} KB${s.unmasked ? ', unmasked' : ', masked'}`
            + (r.missing ? ` · ${r.missing} call(s) no longer readable` : '') }));
          this.changed.emit(w);
        },
        error: (e) => {
          this.building.set(null);
          this.say(e?.error?.message || 'Could not upload the file', true);
        },
      }));
    } catch {
      this.building.set(null);
      this.say('Could not build the file', true);
    }
  }

  /**
   * Approve: the edits are saved, then {@link UNDO_SECONDS} with Undo before anything leaves Alfred. A wide change (more
   * than 5 items, a close, a re-parent, work for someone else) asks once more first (specs/038 G-9).
   */
  async approve(): Promise<void> {
    if (this.counting() !== null || this.busy() || !this.ticked() || !this.open()) return;
    this.message.set(null);
    const why = wideReasons(this.bundle(), this.steps(), this.state.me()?.person.email ?? this.state.me()?.person.name);
    if (why.length && !(await this.confirm.confirm(`Send this to Azure? ${why.join('; ')}.`, 'Approve'))) return;
    this.save(() => {
      this.counting.set(UNDO_SECONDS);
      this.timer = setInterval(() => {
        const left = (this.counting() ?? 1) - 1;
        if (left > 0) {
          this.counting.set(left);
          return;
        }
        this.stop();
        this.send();
      }, 1000);
    });
  }

  undo(): void {
    this.stop();
    this.say('Not sent.');
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.counting.set(null);
  }

  private send(): void {
    this.busy.set(true);
    this.api.approve(this.bundle().id).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.changed.emit(w);
        this.say(w.state === 'DONE' ? 'Sent' : w.state === 'PARTIAL' ? 'Some changes failed - see each one' : 'Sending…', w.state === 'PARTIAL');
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not send', true);
      },
    });
  }

  reject(): void {
    this.busy.set(true);
    this.api.reject(this.bundle().id, this.reason().trim() || undefined).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.edited.set(null);
        this.rejecting.set(false);
        this.changed.emit(w);
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not reject it', true);
      },
    });
  }

  /** Asks Claude in the board chat to rewrite a comment; the new text lands here when it answers. */
  redraft(i: number): void {
    const ask = (this.asks()[i] ?? '').trim();
    if (!ask || this.busy()) return;
    this.busy.set(true);
    this.save(() => this.api.askRedraft(this.bundle().id, i, ask).subscribe({
      next: () => {
        this.busy.set(false);
        this.setAsk(i, '');
        this.say('Asked Claude in the board chat - the new text shows here, marked, when it answers.');
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not ask Claude', true);
      },
    }));
  }

  retry(i: number): void {
    this.busy.set(true);
    this.api.retryStep(this.bundle().id, i).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.changed.emit(w);
        this.say(w.state === 'DONE' ? 'Sent' : 'Still refused - see the step', w.state !== 'DONE');
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not send it again', true);
      },
    });
  }

  /** For the tray's keys. */
  startEdit(): void {
    const i = this.steps().findIndex((s) => s.kind === 'COMMENT');
    if (i >= 0 && this.open() && this.editable()) this.editing.set(i);
  }

  startReject(): void {
    if (this.open() && this.editable()) this.rejecting.set(true);
  }
}

function toggle(set: ReadonlySet<number>, i: number, on: boolean): ReadonlySet<number> {
  const next = new Set(set);
  if (on) next.add(i);
  else next.delete(i);
  return next;
}
