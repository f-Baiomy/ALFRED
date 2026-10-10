import { Component, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import {
  ALL_STATUSES, Actor, BoardFilters, BulkAction, CardKind, CardSummary, FLAGS, FLAG_LABELS, Flag, KINDS, OPEN_STATUSES, Resolution,
} from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardExportFormat, BoardExportService } from '../../../core/services/board-export.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardStateService, messageOf } from '../../../core/state/board-state.service';
import { ActionMenuComponent } from '../../action-menu/action-menu.component';
import { CardAction } from '../board-card/board-card.component';
import { BoardColumnsComponent, CardDrop } from '../board-columns/board-columns.component';
import { BoardHelpComponent } from '../board-help/board-help.component';
import { BoardListViewComponent } from '../board-list-view/board-list-view.component';
import { BoardProgressComponent } from '../board-progress/board-progress.component';
import { BulkBarComponent } from '../bulk-bar/bulk-bar.component';
import { CardDrawerComponent } from '../card-drawer/card-drawer.component';
import { LiveStripComponent } from '../live-strip/live-strip.component';
import { QuickAddComponent } from '../quick-add/quick-add.component';
import { TriageDecision, TriageDialogComponent } from '../triage-dialog/triage-dialog.component';
import { UndoToastComponent } from '../undo-toast/undo-toast.component';

/**
 * One board, wherever it is shown - the Board tab and a session cycle's Board tab use this same view (FR-039: two
 * views, one set of cards). Quick add, filters, Board / List, progress, the live strip, Inbox sorting, bulk actions,
 * the card drawer, export and the keyboard. Each instance has its own BoardStateService.
 */
@Component({
  selector: 'app-board-view',
  standalone: true,
  providers: [BoardStateService],
  imports: [ActionMenuComponent, BoardColumnsComponent, BoardHelpComponent, BoardListViewComponent, BoardProgressComponent,
    BulkBarComponent, CardDrawerComponent, LiveStripComponent, QuickAddComponent, TriageDialogComponent, UndoToastComponent],
  template: `
    <app-live-strip [status]="state.agent()" [editable]="state.editable()" (action)="state.agentAction($event)" />
    <div class="board-top">
      @if (state.editable()) {
        <app-quick-add #quick (added)="state.quickAdd($event)" />
      } @else {
        <span class="board-viewonly" [title]="state.access().howToEdit">👁 View only</span>
      }
      <div class="board-seg" role="group" aria-label="View">
        <button type="button" [class.on]="state.view() === 'board'" (click)="state.view.set('board')">▦ Board</button>
        <button type="button" [class.on]="state.view() === 'list'" (click)="state.view.set('list')">☰ List</button>
      </div>
      <app-action-menu label="Export">
        <button type="button" class="filter-option-item" (click)="export('md')">Board → Markdown (.md)</button>
        <button type="button" class="filter-option-item" (click)="export('html')">Board → HTML (.html)</button>
        <button type="button" class="filter-option-item" (click)="export('json')">Board → JSON (re-importable)</button>
        <button type="button" class="filter-option-item" [disabled]="!state.selected().size" (click)="export('md', true)">Selected cards → .md</button>
        <button type="button" class="filter-option-item" [disabled]="!state.selected().size" (click)="export('json', true)">Selected cards → .json</button>
        @if (state.editable()) {
          <label class="filter-option-item">Import .json…<input type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))" /></label>
        }
      </app-action-menu>
      <button type="button" class="action-btn" title="Keyboard shortcuts (?)" (click)="help.set(true)">?</button>
    </div>
    <div class="board-filters">
      @for (k of kinds; track k) {
        <button type="button" class="board-pill" [class.on]="state.filters().kinds.includes(k)" (click)="toggleKind(k)">{{ k }}</button>
      }
      @for (f of flags; track f) {
        <button type="button" class="board-pill" [class.on]="state.filters().flags.includes(f)" (click)="toggleFlag(f)">{{ flagLabels[f] }}</button>
      }
      <button type="button" class="board-pill" [class.on]="state.filters().author === 'CLAUDE'" (click)="toggleAuthor('CLAUDE')">✦ by Claude</button>
      <button type="button" class="board-pill" [class.on]="state.filters().scopeNotDecided" (click)="toggleScope()">Scope not decided</button>
      <input #search class="board-search" type="search" placeholder="Search cards…" [value]="state.filters().q"
             (keydown.enter)="setSearch(search.value)" (search)="setSearch(search.value)" />
    </div>
    @if (state.page(); as page) {
      <app-board-progress [label]="progressLabel()" [open]="page.counts.open" [fixed]="page.counts.fixed" [done]="page.counts.done" />
    }
    @if (state.error()) { <div class="board-error" role="alert">{{ state.error() }} <button type="button" class="board-link" (click)="state.error.set(null)">✕</button></div> }
    @if (message()) { <div class="board-note">{{ message() }} <button type="button" class="board-link" (click)="message.set(null)">✕</button></div> }

    @if (state.view() === 'board') {
      <app-board-columns [cards]="state.cards()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                         [showCycle]="!cycleId()" [now]="now()"
                         (moved)="onMoved($event)" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)"
                         (action)="onAction($event.card, $event.action)" (triage)="startTriage()" />
    } @else {
      <app-board-list-view [cards]="sortedForList()" [editable]="state.editable()" [selected]="state.selected()" [focusedId]="state.focusedId()"
                           [now]="now()" (opened)="openCard($event)" (toggled)="state.toggleSelected($event.id)" />
    }

    <app-bulk-bar [count]="state.selected().size" (action)="bulk($event)" (cleared)="state.clearSelection()" />
    <app-undo-toast [pending]="state.pendingUndo()" (undo)="state.undo()" (reason)="state.addReason($event)" (dismissed)="state.pendingUndo.set(null)" />
    @if (triageQueue(); as queue) {
      <app-triage-dialog [queue]="queue" (decided)="onTriage($event)" (closed)="triageQueue.set(null)" />
    }
    @if (help()) { <app-board-help (closed)="help.set(false)" /> }
    @if (state.openCardId(); as id) {
      <app-card-drawer [cardId]="id" [version]="state.openCardVersion()" [editable]="state.editable()"
                       (closed)="state.open(null)" (closeRequested)="state.close($event, $event.resolution)" />
    }`,
})
export class BoardViewComponent {
  readonly state = inject(BoardStateService);
  private readonly api = inject(BoardApiService);
  private readonly exports = inject(BoardExportService);
  private readonly mentions = inject(BoardMentionsService);

  readonly project = input('');
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input<string | null>(null);

  readonly kinds = KINDS;
  readonly flags = FLAGS;
  readonly flagLabels = FLAG_LABELS;
  readonly help = signal(false);
  readonly message = signal<string | null>(null);
  readonly triageQueue = signal<readonly CardSummary[] | null>(null);
  /** "Now" for ages and the stale marker - refreshed whenever the cards are, so it needs no clock of its own. */
  readonly now = computed(() => (this.state.page(), Date.now()));
  private readonly quick = viewChild<QuickAddComponent>('quick');

  readonly progressLabel = computed(() => (this.cycleId() ? this.cycleName() ?? this.cycleId()! : this.project() || 'No project'));
  readonly sortedForList = computed(() => [...this.state.cards()].sort((a, b) =>
    ALL_STATUSES.indexOf(a.status) - ALL_STATUSES.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)));
  /** Cards in the order J/K walks them: the board's columns left to right, or the list's rows. */
  private readonly walkOrder = computed(() => this.sortedForList());

  constructor() {
    effect(() => {
      const project = this.project();
      const cycleId = this.cycleId();
      untracked(() => this.state.show(project, cycleId));
    });
    effect(() => {
      const target = this.mentions.cardToOpen();
      if (!target) return;
      untracked(() => {
        const here = this.state.cards().find((c) => c.number === target.number && c.project === target.project);
        if (here) {
          this.state.open(here.id);
          this.mentions.cardToOpen.set(null);
          return;
        }
        if (target.project !== this.project() && !this.cycleId()) return; // another board's card
        this.api.cardByNumber(target.project, target.number).subscribe({
          next: (c) => {
            this.state.open(c.id);
            this.mentions.cardToOpen.set(null);
          },
          error: () => this.message.set(`Card #${target.number} no longer exists`),
        });
      });
    });
  }

  openCard(card: CardSummary): void {
    this.state.focusedId.set(card.id);
    this.state.open(card.id);
  }

  onMoved(drop: CardDrop): void {
    this.state.move(drop.card.id, drop.to);
  }

  onAction(card: CardSummary, action: CardAction): void {
    if (action.kind === 'close') this.state.close(card, action.resolution);
    else if (action.kind === 'move') this.state.move(card.id, action.status);
    else this.state.reopen(card.id);
  }

  startTriage(): void {
    this.triageQueue.set(this.state.cards().filter((c) => c.status === 'INBOX'));
  }

  onTriage(d: TriageDecision): void {
    if (d.kind === 'todo') this.state.move(d.card.id, 'TO_DO');
    else this.state.run(this.api.close(d.card.id, d.resolution, d.reason || undefined));
  }

  bulk(action: BulkAction): void {
    this.state.bulk(action);
  }

  private setFilters(change: Partial<BoardFilters>): void {
    this.state.setFilters({ ...this.state.filters(), ...change });
  }

  toggleKind(k: CardKind): void {
    const kinds = this.state.filters().kinds;
    this.setFilters({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  }

  toggleFlag(f: Flag): void {
    const flags = this.state.filters().flags;
    this.setFilters({ flags: flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f] });
  }

  toggleAuthor(a: Actor): void {
    this.setFilters({ author: this.state.filters().author === a ? null : a });
  }

  toggleScope(): void {
    this.setFilters({ scopeNotDecided: !this.state.filters().scopeNotDecided });
  }

  setSearch(q: string): void {
    this.setFilters({ q });
  }

  export(format: BoardExportFormat, selectedOnly = false): void {
    const title = this.cycleId() ? `Board - ${this.cycleName() ?? this.cycleId()}` : `Board - ${this.project() || 'No project'}`;
    this.message.set('Gathering the board for export…');
    this.exports.download(format, this.project(), this.cycleId(), title, selectedOnly ? [...this.state.selected()] : null)
      .then(() => this.message.set(null), (e) => this.message.set(messageOf(e)));
  }

  importFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.api.importBoard(this.project(), file).subscribe({
      next: (r) => this.message.set(`Imported ${r.cards} cards${r.renumbered.length
        ? ` - renumbered ${r.renumbered.map((x) => `#${x.from} → #${x.to}`).join(', ')}` : ''}`),
      error: (e) => this.state.error.set(messageOf(e)),
    });
  }

  // ---------------------------------------------------------------------------------------------------------- keys

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (this.triageQueue() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      if (this.help()) this.help.set(false);
      else if (this.state.openCardId()) this.state.open(null);
      else this.state.clearSelection();
      return;
    }
    if (document.querySelector('.dialog-backdrop')) return;
    const key = event.key.toLowerCase();
    if (key === '?') {
      this.help.set(true);
    } else if (key === '/') {
      event.preventDefault();
      this.quick()?.focus();
    } else if (key === 'l') {
      this.state.view.update((v) => (v === 'board' ? 'list' : 'board'));
    } else if (key === 'j' || key === 'k') {
      event.preventDefault();
      this.walk(key === 'j' ? 1 : -1);
    } else {
      this.onCardKey(key, event);
    }
  }

  private walk(step: number): void {
    const cards = this.walkOrder();
    if (!cards.length) return;
    const at = cards.findIndex((c) => c.id === this.state.focusedId());
    const next = cards[Math.max(0, Math.min(cards.length - 1, at < 0 ? 0 : at + step))];
    this.state.focusedId.set(next.id);
    document.querySelector(`[data-card="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private onCardKey(key: string, event: KeyboardEvent): void {
    const card = this.state.cards().find((c) => c.id === this.state.focusedId());
    if (!card) return;
    if (key === 'enter') {
      this.state.open(card.id);
      return;
    }
    if (!this.state.editable()) return;
    const inbox = card.status === 'INBOX';
    const sorts: Record<string, Resolution> = { f: 'FINE', n: 'NOT_IN_FLOW' };
    if (inbox && sorts[key]) this.state.close(card, sorts[key]);
    else if (inbox && key === 't') this.state.move(card.id, 'TO_DO');
    else if (key === 'x') this.state.toggleSelected(card.id);
    else if (key === 'u') {
      const flags = card.flags.includes('URGENT') ? card.flags.filter((f) => f !== 'URGENT') : [...card.flags, 'URGENT' as Flag];
      this.state.run(this.api.update(card.id, { flags }));
    } else if (/^[1-6]$/.test(key) && card.status !== 'CLOSED') {
      const to = OPEN_STATUSES[Number(key) - 1];
      if (to !== card.status) this.state.move(card.id, to);
    } else {
      return;
    }
    event.preventDefault();
  }
}
