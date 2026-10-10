import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import {
  ActivityEntry, CardDetail, CardKind, Proposal, CardStatus, FLAGS, FLAG_LABELS, Flag, KINDS, MentionRef, OPEN_STATUSES, RESOLUTION_LABELS,
  Resolution, SCOPE_LABELS, STATUS_LABELS, Scope,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { messageOf } from '../../../core/state/board-state.service';
import { proposalTarget } from '../../../shared/utils/board-activity';
import { ActivityTimelineComponent } from '../activity-timeline/activity-timeline.component';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';
import { MentionPickerComponent } from '../mention-picker/mention-picker.component';

/**
 * One card opened (FR-027..029, mock "drawer"): status, kind, scope and flags; the description with its mentions; the
 * Linked list (mentions plus direct links); the full history; and a comment box. Re-reads itself whenever the board
 * says this card changed (`version`).
 */
@Component({
  selector: 'app-card-drawer',
  standalone: true,
  imports: [ActivityTimelineComponent, MarkdownViewComponent, MentionChipComponent, MentionEditorComponent, MentionPickerComponent],
  template: `
    <aside class="board-drawer" role="dialog" aria-label="Card">
      @if (card(); as c) {
        <div class="board-drawer-head">
          <button type="button" class="board-drawer-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
          <div class="board-card-row">
            <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span>
            @if (c.author === 'CLAUDE') { <span class="board-ai">✦ found by Claude</span> }
            @if (c.cycleId) { <span class="board-cyc">◷ {{ c.cycleDeleted ? 'cycle deleted' : c.cycleId }}</span> }
            <span class="board-dim">#{{ c.number }}</span>
          </div>
          @if (editingTitle()) {
            <input #title class="board-drawer-title-input" type="text" maxlength="300" [value]="c.title"
                   (keydown.enter)="saveTitle(title.value)" (keydown.escape)="editingTitle.set(false)" (blur)="saveTitle(title.value)" />
          } @else {
            <h2 class="board-drawer-title" [title]="editable() ? 'Click to rename' : ''" (click)="editable() && editingTitle.set(true)">{{ c.title }}</h2>
          }
          <div class="board-drawer-controls">
            <label>Status
              <select [disabled]="!editable()" [value]="statusValue()" (change)="changeStatus($any($event.target).value)">
                @for (s of openStatuses; track s) { <option [value]="s">{{ statusLabels[s] }}</option> }
                @for (r of resolutions; track r) { <option [value]="'CLOSED:' + r">Closed · {{ resolutionLabels[r] }}</option> }
              </select>
            </label>
            <label>Kind
              <select [disabled]="!editable()" [value]="c.kind" (change)="save({ kind: $any($event.target).value })">
                @for (k of kinds; track k) { <option [value]="k">{{ k }}</option> }
              </select>
            </label>
            <label>Scope
              <select [disabled]="!editable()" [value]="c.scope" (change)="save({ scope: $any($event.target).value })">
                @for (s of scopes; track s) { <option [value]="s">{{ scopeLabels[s] }}</option> }
              </select>
            </label>
          </div>
          <div class="board-drawer-controls">
            @for (f of flags; track f) {
              <button type="button" class="board-tog" [class]="'board-tog board-flag-' + f" [class.on]="c.flags.includes(f)"
                      [disabled]="!editable()" (click)="toggleFlag(f)">{{ flagLabels[f] }}</button>
            }
          </div>
          @if (c.reason) { <div class="board-card-reason">Reason: “{{ c.reason }}”</div> }
          @if (c.similarClosed; as s) { <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabels[s.resolution] }}{{ s.reason ? ': ' + s.reason : '' }}</div> }
          @if (c.proposal; as p) {
            <div class="board-proposal" role="group" aria-label="Claude's proposal">
              <div class="board-proposal-head"><b>✦ Claude proposes: {{ proposalText(p) }}</b></div>
              @if (p.reason) { <div class="board-proposal-reason">“{{ p.reason }}”</div> }
              @if (p.evidence) { <app-markdown-view class="board-proposal-evidence" [text]="p.evidence" /> }
              <div class="board-proposal-actions">
                <button type="button" class="action-btn primary" [disabled]="!editable()" (click)="acceptProposal()">Accept</button>
                <button type="button" class="action-btn" [disabled]="!editable()" (click)="dismissProposal()">Dismiss</button>
              </div>
            </div>
          }
        </div>
        <div class="board-drawer-body">
          <section>
            <h4>Description
              @if (editable() && !editingDescription()) { <button type="button" class="board-link" (click)="editingDescription.set(true)">Edit</button> }
            </h4>
            @if (editingDescription()) {
              <app-mention-editor [value]="descriptionDraft() ?? c.description" [project]="c.project" [cycleId]="c.cycleId" [contextMentions]="c.links"
                                  [card]="pickTarget()" pickField="description"
                                  submitLabel="Save" [cancellable]="true" [allowEmpty]="true" [rows]="8"
                                  (submitted)="saveDescription($event)" (cancelled)="editingDescription.set(false); descriptionDraft.set(null)" />
            } @else {
              <div class="board-desc"><app-markdown-view [text]="c.description" empty="No description yet." [idPrefix]="'card-' + c.id + '-'" /></div>
            }
          </section>
          <section>
            <h4>Linked <span class="board-dim">from mentions</span>
              @if (editable()) { <button type="button" class="board-link" (click)="linking.set(!linking())">+ link</button> }
            </h4>
            @if (linking()) {
              <app-mention-picker [project]="c.project" [cycleId]="c.cycleId" [calls]="callLinks()" [canPickAnywhere]="true"
                                (pickAnywhere)="pickLinksFromAnywhere()" (picked)="addLink($event)" (closed)="linking.set(false)" />
            }
            <div class="board-links">
              @for (m of c.links; track m.type + m.ref) { <app-mention-chip [mention]="m" /> } @empty { <span class="board-dim">Nothing linked.</span> }
            </div>
          </section>
          <section>
            <h4>Activity · what was done <span class="board-dim">{{ activityTotal() }} entries</span></h4>
            <app-activity-timeline [entries]="activity()" />
          </section>
          @if (editable()) {
            <section class="board-drawer-danger">
              <button type="button" class="action-btn danger" (click)="remove()">Delete card…</button>
            </section>
          }
        </div>
        @if (editable()) {
          <div class="board-drawer-composer">
            <app-mention-editor [value]="draft()" (valueChange)="draft.set($event)" [project]="c.project" [cycleId]="c.cycleId"
                                [contextMentions]="c.links" [card]="pickTarget()" pickField="comment" (submitted)="comment($event)" />
          </div>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      } @else {
        <div class="board-drawer-head"><button type="button" class="board-drawer-x" (click)="closed.emit()">✕</button>
          <span class="board-dim">{{ error() ?? 'Loading…' }}</span></div>
      }
    </aside>`,
})
export class CardDrawerComponent {
  private readonly api = inject(BoardApiService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly mentions = inject(BoardMentionsService);

  readonly cardId = input.required<string>();
  readonly version = input(0);
  readonly editable = input(true);
  readonly closed = output<void>();
  readonly closeRequested = output<{ id: string; number: number; resolution: Resolution }>();

  readonly card = signal<CardDetail | null>(null);
  readonly activity = signal<readonly ActivityEntry[]>([]);
  readonly activityTotal = signal(0);
  readonly error = signal<string | null>(null);
  readonly editingTitle = signal(false);
  readonly editingDescription = signal(false);
  readonly linking = signal(false);
  readonly draft = signal('');
  /** The description being edited when a pick from anywhere came back into it. */
  readonly descriptionDraft = signal<string | null>(null);

  readonly openStatuses = OPEN_STATUSES;
  readonly resolutions: readonly Resolution[] = ['FINE', 'NOT_IN_FLOW', 'WONT_FIX'];
  readonly kinds = KINDS;
  readonly flags = FLAGS;
  readonly scopes: readonly Scope[] = ['NOT_DECIDED', 'IN_SCOPE', 'OUT_OF_SCOPE'];
  readonly statusLabels = STATUS_LABELS;
  readonly resolutionLabels = RESOLUTION_LABELS;
  readonly scopeLabels = SCOPE_LABELS;
  readonly flagLabels = FLAG_LABELS;

  readonly statusValue = computed(() => {
    const c = this.card();
    return !c ? '' : c.status === 'CLOSED' ? `CLOSED:${c.resolution}` : c.status;
  });
  readonly pickTarget = computed(() => {
    const c = this.card();
    return c ? { id: c.id, project: c.project, number: c.number, cycleId: c.cycleId } : null;
  });
  readonly callLinks = computed(() => (this.card()?.links ?? []).filter((m) => m.type.toLowerCase() === 'call'));

  constructor() {
    effect(() => {
      const id = this.cardId();
      this.version();
      untracked(() => this.load(id));
    });
  }

  private load(id: string): void {
    this.api.card(id).subscribe({
      next: (c) => {
        this.card.set(c);
        this.error.set(null);
        this.restorePickedText(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
    this.api.activity(id).subscribe({
      next: (page) => {
        this.activity.set(page.entries);
        this.activityTotal.set(page.total);
      },
      error: () => undefined,
    });
  }

  private apply(call: ReturnType<BoardApiService['update']>): void {
    call.subscribe({
      next: (c) => {
        this.card.set(c);
        this.error.set(null);
        this.load(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  proposalText(p: Proposal): string {
    return proposalTarget(p.status === 'CLOSED' && p.resolution ? `CLOSED:${p.resolution}` : p.status);
  }

  /** Takes Claude's proposed step as the user's own. */
  acceptProposal(): void {
    const c = this.card();
    if (c) this.apply(this.api.acceptProposal(c.id));
  }

  dismissProposal(): void {
    const c = this.card();
    if (c) this.apply(this.api.dismissProposal(c.id));
  }

  save(edit: { kind?: CardKind; scope?: Scope; flags?: readonly Flag[]; title?: string; description?: string }): void {
    const c = this.card();
    if (c) this.apply(this.api.update(c.id, edit));
  }

  saveTitle(title: string): void {
    this.editingTitle.set(false);
    const c = this.card();
    if (c && title.trim() && title.trim() !== c.title) this.save({ title: title.trim() });
  }

  saveDescription(text: string): void {
    this.editingDescription.set(false);
    this.descriptionDraft.set(null);
    this.save({ description: text });
  }

  toggleFlag(f: Flag): void {
    const c = this.card();
    if (!c) return;
    this.save({ flags: c.flags.includes(f) ? c.flags.filter((x) => x !== f) : [...c.flags, f] });
  }

  changeStatus(value: string): void {
    const c = this.card();
    if (!c) return;
    if (value.startsWith('CLOSED:')) {
      const resolution = value.slice('CLOSED:'.length) as Resolution;
      if (c.status === 'CLOSED') {
        // a different resolution on a closed card: reopen, then close again, so the history shows both
        this.api.reopen(c.id).subscribe({ next: () => this.closeRequested.emit({ id: c.id, number: c.number, resolution }),
          error: (e) => this.error.set(messageOf(e)) });
      } else {
        this.closeRequested.emit({ id: c.id, number: c.number, resolution });
      }
      return;
    }
    if (c.status === 'CLOSED') {
      this.api.reopen(c.id).subscribe({
        next: () => (value === 'INBOX' ? this.load(c.id) : this.apply(this.api.move(c.id, value as CardStatus))),
        error: (e) => this.error.set(messageOf(e)),
      });
      return;
    }
    this.apply(this.api.move(c.id, value as CardStatus));
  }

  /** "+ link" → Pick from anywhere: the picked calls come back as links on this card. */
  pickLinksFromAnywhere(): void {
    const target = this.pickTarget();
    if (!target) return;
    this.linking.set(false);
    this.mentions.pickForCard(target, { kind: 'links' });
  }

  /** Back from a pick started in the comment box or the description: the text, with the picked calls in it, is put back. */
  private restorePickedText(cardId: string): void {
    const back = this.mentions.takePickedText(cardId);
    if (!back) return;
    if (back.field === 'comment') {
      this.draft.set(back.text);
    } else {
      this.descriptionDraft.set(back.text);
      this.editingDescription.set(true);
    }
  }

  addLink(ref: MentionRef): void {
    this.linking.set(false);
    const c = this.card();
    if (c) this.apply(this.api.link(c.id, ref));
  }

  comment(text: string): void {
    const c = this.card();
    if (!c) return;
    this.api.comment(c.id, text).subscribe({
      next: () => {
        this.draft.set('');
        this.load(c.id);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  remove(): void {
    const c = this.card();
    if (!c) return;
    this.confirm.confirm(`Delete card #${c.number} “${c.title}” and its whole history? This cannot be undone.`, 'Delete').then((ok) => {
      if (!ok) return;
      this.api.delete(c.id).subscribe({ next: () => this.closed.emit(), error: (e) => this.error.set(messageOf(e)) });
    });
  }
}
