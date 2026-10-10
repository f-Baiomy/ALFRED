import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, auditTime, merge } from 'rxjs';
import {
  AgentStatus, BoardAccess, BoardFilters, BulkAction, CardDetail, CardStatus, CardSummary, CardsPage, NO_FILTERS, Resolution,
} from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardSocketService } from '../services/board-socket.service';

/** A close that can still be undone from the toast. */
export interface PendingUndo {
  readonly id: string;
  readonly number: number;
  readonly resolution: Resolution;
}

/**
 * One board view's state (the Board tab, or the Board tab of a session cycle): which project or cycle it shows, its
 * filters, the loaded cards, the selection and the open card. Provided per view (not root), so two views can show two
 * boards. Fetch-on-demand: one fetch on open, then one per /ws/board signal that concerns this view (no timers).
 */
@Injectable()
export class BoardStateService {
  private readonly api = inject(BoardApiService);
  private readonly socket = inject(BoardSocketService);
  private readonly refresh$ = new Subject<void>();

  readonly project = signal('');
  readonly cycleId = signal<string | null>(null);
  readonly filters = signal<BoardFilters>(NO_FILTERS);
  readonly view = signal<'board' | 'list'>('board');
  readonly page = signal<CardsPage | null>(null);
  readonly error = signal<string | null>(null);
  readonly access = signal<BoardAccess>({ editable: true, reason: 'LOCAL', howToEdit: '' });
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly focusedId = signal<string | null>(null);
  readonly openCardId = signal<string | null>(null);
  readonly pendingUndo = signal<PendingUndo | null>(null);
  readonly agent = signal<AgentStatus | null>(null);
  /** Bumped on every signal for the open card, so the drawer re-reads it. */
  readonly openCardVersion = signal(0);

  readonly cards = computed<readonly CardSummary[]>(() => this.page()?.cards ?? []);
  readonly editable = computed(() => this.access().editable);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.refresh$.pipe(auditTime(120), takeUntilDestroyed(destroyRef)).subscribe(() => this.load());
    this.socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe((event) => {
      if (event.type === 'agent-status') {
        if (event.project === this.project()) this.agent.set(event);
        return;
      }
      if (this.concerns(event.project, event.cycleId)) {
        this.refresh$.next();
        if (event.cardId && event.cardId === this.openCardId()) this.openCardVersion.update((v) => v + 1);
      }
    });
    merge(this.socket.reconnected$).pipe(takeUntilDestroyed(destroyRef)).subscribe(() => {
      this.loadAccess();
      this.refresh$.next();
    });
  }

  /** Shows a project's board, or (with a cycle) that cycle's cards. */
  show(project: string, cycleId: string | null): void {
    this.project.set(project);
    this.cycleId.set(cycleId);
    this.selected.set(new Set());
    this.loadAccess();
    this.load();
    this.api.agentStatus(project).subscribe({ next: (s) => this.agent.set(s), error: () => this.agent.set(null) });
  }

  setFilters(filters: BoardFilters): void {
    this.filters.set(filters);
    this.load();
  }

  reload(): void {
    this.refresh$.next();
  }

  private concerns(project: string | undefined, cycleId: string | undefined): boolean {
    const mine = this.cycleId();
    if (mine) return cycleId === mine || (cycleId === undefined && project !== undefined);
    return project === undefined ? false : project === this.project();
  }

  private load(): void {
    this.api.cards(this.project(), this.cycleId(), this.filters()).subscribe({
      next: (page) => {
        this.page.set(page);
        this.error.set(null);
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  private loadAccess(): void {
    this.api.access().subscribe({ next: (a) => this.access.set(a), error: () => undefined });
  }

  // ---------------------------------------------------------------------------------------------------------- writes

  /** Runs a write; on failure the board shows why. Every success arrives as a socket signal, so nothing re-fetches here. */
  run<T>(call: Observable<T>, then?: (value: T) => void): void {
    call.subscribe({
      next: (v) => {
        this.error.set(null);
        then?.(v);
        this.refresh$.next();
      },
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  quickAdd(text: string, then?: (card: CardDetail) => void): void {
    this.run(this.api.quickAdd(this.project(), this.cycleId(), text), then);
  }

  move(id: string, status: CardStatus): void {
    this.run(this.api.move(id, status));
  }

  close(card: Pick<CardSummary, 'id' | 'number'>, resolution: Resolution, reason?: string): void {
    this.run(this.api.close(card.id, resolution, reason), () => this.pendingUndo.set({ id: card.id, number: card.number, resolution }));
  }

  undo(): void {
    const pending = this.pendingUndo();
    if (!pending) return;
    this.pendingUndo.set(null);
    this.run(this.api.undoClose(pending.id));
  }

  addReason(reason: string): void {
    const pending = this.pendingUndo();
    if (!pending || !reason.trim()) return;
    this.run(this.api.setReason(pending.id, reason.trim()));
  }

  reopen(id: string): void {
    this.run(this.api.reopen(id));
  }

  bulk(action: BulkAction, reason?: string): void {
    const ids = [...this.selected()];
    if (!ids.length) return;
    this.run(this.api.bulk(ids, action, reason), () => this.selected.set(new Set()));
  }

  delete(id: string): void {
    this.run(this.api.delete(id), () => {
      if (this.openCardId() === id) this.openCardId.set(null);
    });
  }

  toggleSelected(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  open(id: string | null): void {
    this.openCardId.set(id);
  }

  agentAction(action: 'pause' | 'resume' | 'stop'): void {
    this.run(this.api.agentAction(this.project(), action), (s) => this.agent.set(s));
  }
}

/** The backend's {error, message} body, or a plain line. */
export function messageOf(e: unknown): string {
  const body = (e as { error?: { message?: string; error?: string } })?.error;
  if (body && typeof body === 'object') return body.message || body.error || 'Request failed';
  return (e as { message?: string })?.message ?? 'Request failed';
}
