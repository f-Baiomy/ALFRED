import { Component, HostListener, QueryList, ViewChildren, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BundleOutboxService } from '../../../core/team/bundle-outbox.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { TeamConsentBundleComponent } from '../consent-bundle/consent-bundle.component';

/**
 * The board header's "To send to Azure" tray (specs/034): every bundle waiting on this board as one review each, Approve
 * all, and keys - A approve, E edit, R reject, J/K next/previous, Esc close - while focus is not in a field. Bundles that
 * ended with a refused step follow, each with Retry.
 */
@Component({
  selector: 'app-team-outbox-tray',
  standalone: true,
  imports: [TeamConsentBundleComponent],
  template: `
    <section class="tob" aria-label="To send to Azure">
      <div class="tob-h">
        <b>To send to Azure</b>
        <span class="tcb-dim">prepared by Claude · nothing is sent before you approve ·
          @if (team.hasToken()) { token ✓ live } @else { <span class="tob-warn">needs your token (Team tab)</span> }</span>
        <span class="tcb-grow"></span>
        @if (editable() && outbox.count() > 1) {
          <button type="button" class="action-btn primary" [disabled]="!team.hasToken()" (click)="approveAll()">Approve all ({{ outbox.changes() }} changes)</button>
        }
        <button type="button" class="board-link" (click)="closed.emit()" aria-label="Close">✕</button>
      </div>
      @for (b of outbox.waiting(); track b.id; let i = $index) {
        <app-team-consent-bundle [bundle]="b" [editable]="editable()" [cardNumber]="numbers()[b.cardId ?? ''] ?? null" [showOpen]="true"
                                 [active]="i === sel()" (changed)="outbox.replace($event)" (openCard)="openCard($event)" (click)="sel.set(i)" />
      } @empty {
        <div class="tcb-dim">Nothing waits to go to Azure.</div>
      }
      @if (outbox.partial().length) {
        <div class="tcb-dim tob-sub">Not all sent - retry a step or leave it:</div>
        @for (b of outbox.partial(); track b.id) {
          <app-team-consent-bundle [bundle]="b" [editable]="editable()" [cardNumber]="numbers()[b.cardId ?? ''] ?? null" [showOpen]="true"
                                   (changed)="outbox.replace($event)" (openCard)="openCard($event)" />
        }
      }
      @if (outbox.count() > 1) {
        <div class="tcb-dim tob-keys"><kbd>A</kbd> approve · <kbd>E</kbd> edit · <kbd>R</kbd> reject · <kbd>J</kbd>/<kbd>K</kbd> next / previous · <kbd>Esc</kbd> close</div>
      }
    </section>`,
})
export class OutboxTrayComponent {
  readonly outbox = inject(BundleOutboxService);
  readonly team = inject(TeamStateService);
  private readonly boards = inject(BoardApiService);
  private readonly mentions = inject(BoardMentionsService);

  readonly project = input('');
  readonly editable = input(true);
  readonly closed = output<void>();

  @ViewChildren(TeamConsentBundleComponent) reviews!: QueryList<TeamConsentBundleComponent>;

  readonly sel = signal(0);
  readonly numbers = signal<Record<string, number>>({});
  private readonly cardIds = computed(() => [...new Set([...this.outbox.waiting(), ...this.outbox.partial()].map((b) => b.cardId).filter((c): c is string => !!c))]);

  constructor() {
    effect(() => {
      const ids = this.cardIds();
      untracked(() => {
        for (const id of ids) {
          if (this.numbers()[id] !== undefined) continue;
          this.boards.card(id).subscribe({ next: (d) => this.numbers.update((n) => ({ ...n, [id]: d.number })), error: () => undefined });
        }
      });
    });
    effect(() => {
      const n = this.outbox.count();
      untracked(() => this.sel.update((s) => Math.max(0, Math.min(s, n - 1))));
    }, { allowSignalWrites: true });
  }

  openCard(cardId: string): void {
    const n = this.numbers()[cardId];
    if (n !== undefined) this.mentions.cardToOpen.set({ project: this.project(), number: n });
  }

  approveAll(): void {
    this.reviews.forEach((r) => r.open() && r.approve());
  }

  @HostListener('document:keydown', ['$event'])
  keys(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    const list = this.reviews?.toArray() ?? [];
    const cur = list[this.sel()];
    switch (e.key.toLowerCase()) {
      case 'j': this.sel.update((s) => Math.min(s + 1, Math.max(0, this.outbox.count() - 1))); break;
      case 'k': this.sel.update((s) => Math.max(s - 1, 0)); break;
      case 'a': if (this.editable() && cur) cur.approve(); break;
      case 'e': if (cur) cur.startEdit(); break;
      case 'r': if (cur) cur.startReject(); break;
      case 'escape': this.closed.emit(); break;
      default: return;
    }
    e.preventDefault();
  }
}
