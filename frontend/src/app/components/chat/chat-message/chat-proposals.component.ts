import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ChatMessage, ChatProposal } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { messageOf } from '../../../core/state/board-state.service';

/** How long the Undo toast stays (FR-046: at least 6 s; the server keeps the undo for 60 s). */
const TOAST_MS = 8000;

/**
 * Claude's proposals in a chat answer (specs/022 FR-026, FR-046): Accept / Decline one by one, or tick several and accept
 * them together. Each is checked against the board when shown and again on Accept - one that no longer applies reads
 * "already done" or "outdated: …" and cannot be accepted. An accept offers Undo in a toast for the minute the server keeps
 * it, and an applied one keeps its own Undo after that - refused, with why, when the board changed since.
 */
@Component({
  selector: 'app-chat-proposals',
  standalone: true,
  template: `
    <div class="chat-props">
      @for (p of proposals(); track p.id) {
        <div class="chat-prop" [class.done]="!!p.state" [class.stale]="!p.state && !!stale()[p.id]">
          @if (!p.state && editable() && !stale()[p.id]) {
            <input type="checkbox" [checked]="ticked().has(p.id)" (change)="tick(p.id, $any($event.target).checked)" title="Accept together" />
          }
          <span class="txt">{{ p.text || p.kind }}</span>
          @if (p.state) {
            <span class="st" [class.ok]="p.state === 'applied'">{{ p.state === 'outdated' ? (p.why ?? 'outdated') : p.state }}</span>
            @if (p.state === 'applied' && editable()) {
              <button type="button" class="board-link" [disabled]="undoing() === p.id" title="Put back what this changed" (click)="undoOne(p.id)">{{ undoing() === p.id ? 'undoing…' : 'Undo' }}</button>
            }
          } @else if (stale()[p.id]) {
            <span class="st">{{ stale()[p.id] }}</span>
          } @else if (editable()) {
            <button type="button" class="board-tog on" (click)="decide([p.id], [])">Accept</button>
            <button type="button" class="board-link" (click)="decide([], [p.id])">Decline</button>
          }
        </div>
      }
      @if (editable() && openCount() > 1) {
        <div class="board-ev-acts">
          <button type="button" class="action-btn" [disabled]="!ticked().size" (click)="acceptTicked()">Accept {{ ticked().size }} ticked</button>
          <button type="button" class="action-btn primary" (click)="decide(openIds(), [])">Accept all</button>
        </div>
      }
      @if (toast(); as t) {
        <div class="board-toast" role="status">
          <span>{{ t.text }}</span>
          @if (t.token) { <button type="button" class="action-btn" (click)="undo(t.token)">Undo</button> }
          <button type="button" class="board-toast-x" title="Dismiss" (click)="toast.set(null)">✕</button>
        </div>
      }
      @if (error(); as e) { <div class="board-error" role="alert">{{ e }}</div> }
    </div>`,
})
export class ChatProposalsComponent implements OnDestroy {
  private readonly api = inject(ChatApiService);
  private readonly state = inject(ChatStateService);
  readonly message = input.required<ChatMessage>();
  readonly editable = input(true);

  readonly proposals = computed<readonly ChatProposal[]>(() => {
    const ps = (this.message().extra as { proposals?: unknown } | null)?.proposals;
    return Array.isArray(ps) ? (ps as ChatProposal[]).filter((p) => p && typeof p.id === 'string') : [];
  });
  readonly openIds = computed(() => this.proposals().filter((p) => !p.state && !this.stale()[p.id]).map((p) => p.id));
  readonly openCount = computed(() => this.openIds().length);
  /** The board checked when shown: why each open proposal cannot be accepted, null when it can. */
  readonly stale = signal<Readonly<Record<string, string | null>>>({});
  readonly ticked = signal<ReadonlySet<string>>(new Set());
  readonly toast = signal<{ text: string; token: string | null } | null>(null);
  readonly error = signal<string | null>(null);
  readonly undoing = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-checked whenever the message changes (a signal brought a new version), never on a timer.
    effect(() => {
      const m = this.message();
      if (!this.proposals().some((p) => !p.state)) return;
      untracked(() => this.api.checkProposals(m.id).subscribe({ next: (r) => this.stale.set(r.checks), error: () => this.stale.set({}) }));
    });
  }

  tick(id: string, on: boolean): void {
    const next = new Set(this.ticked());
    if (on) next.add(id); else next.delete(id);
    this.ticked.set(next);
  }

  acceptTicked(): void {
    this.decide([...this.ticked()], []);
  }

  decide(accept: readonly string[], decline: readonly string[]): void {
    const m = this.message();
    this.api.proposals(m.id, accept, decline).subscribe({
      next: (out) => {
        this.error.set(null);
        this.ticked.set(new Set());
        const applied = Object.values(out.results).filter((r) => r === 'applied').length;
        const other = Object.entries(out.results).filter(([, r]) => r !== 'applied' && r !== 'declined').map(([id, r]) => `${id}: ${r}`);
        if (applied || other.length) this.show(`${applied ? `${applied} applied` : 'nothing applied'}${other.length ? ` · ${other.join(' · ')}` : ''}`, out.undoToken);
        this.state.changedLocally(m.scope);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** One applied proposal put back - any time, while the board is still as it left it (else the server says why). */
  undoOne(id: string): void {
    const m = this.message();
    this.undoing.set(id);
    this.api.undoProposal(m.id, id).subscribe({
      next: () => { this.undoing.set(null); this.error.set(null); this.toast.set(null); this.state.changedLocally(m.scope); },
      error: (e) => { this.undoing.set(null); this.error.set(messageOf(e)); this.state.changedLocally(m.scope); },
    });
  }

  undo(token: string): void {
    const m = this.message();
    this.api.undo(token).subscribe({
      next: () => { this.toast.set(null); this.state.changedLocally(m.scope); },
      error: (e) => { this.toast.set(null); this.error.set(messageOf(e)); this.state.changedLocally(m.scope); },
    });
  }

  private show(text: string, token: string | null): void {
    this.clear();
    this.toast.set({ text, token });
    this.timer = setTimeout(() => this.toast.set(null), TOAST_MS);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  ngOnDestroy(): void {
    this.clear();
  }
}
