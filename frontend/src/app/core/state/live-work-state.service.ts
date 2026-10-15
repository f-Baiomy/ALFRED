import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LiveWork } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardSocketService } from '../services/board-socket.service';

/** How long a finished live answer stays folded on its card ("✦ 6 s · 4 steps ▸"). */
export const LIVE_ENDED_SHOWN_MS = 10 * 60 * 1000;

/**
 * /alfred-live's work on cards, shared by the board column, the card drawer and the live strip (docs/board.md
 * "Live answers"). Read once, then kept current from /ws/board `live-work` messages - every step arrives as one - and
 * re-read after the socket was away. No polling.
 */
@Injectable({ providedIn: 'root' })
export class LiveWorkStateService {
  private readonly api = inject(BoardApiService);
  private readonly byId = signal<ReadonlyMap<string, LiveWork>>(new Map());

  /** Every run, oldest first. */
  readonly all = computed(() => [...this.byId().values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
  readonly working = computed(() => this.all().filter((w) => w.state === 'WORKING'));

  constructor() {
    const socket = inject(BoardSocketService);
    socket.events$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((e) => {
      if (e.type === 'live-work') this.put(e.work);
    });
    socket.reconnected$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(() => this.load());
    this.load();
  }

  load(): void {
    this.api.liveWork().subscribe({
      next: (list) => this.byId.set(new Map(list.map((w) => [w.id, w]))),
      error: () => undefined,
    });
  }

  put(work: LiveWork): void {
    const next = new Map(this.byId());
    next.set(work.id, work);
    this.byId.set(next);
  }

  /** The run on a card that is working now, else the latest one that ended recently. */
  forCard(project: string, number: number, now = Date.now()): LiveWork | null {
    const mine = this.all().filter((w) => w.project === project && w.cardNumber === number);
    const working = mine.filter((w) => w.state === 'WORKING');
    if (working.length) return working[working.length - 1];
    const ended = mine.filter((w) => now - Date.parse(w.updatedAt) < LIVE_ENDED_SHOWN_MS);
    return ended.length ? ended[ended.length - 1] : null;
  }

  /** The run answering a chat message (specs/022): working now, else the one that ended recently. */
  forChatMessage(messageId: number, now = Date.now()): LiveWork | null {
    const mine = this.all().filter((w) => w.chatMessageId === messageId);
    const working = mine.filter((w) => w.state === 'WORKING');
    if (working.length) return working[working.length - 1];
    const ended = mine.filter((w) => now - Date.parse(w.updatedAt) < LIVE_ENDED_SHOWN_MS);
    return ended.length ? ended[ended.length - 1] : null;
  }

  stop(id: string): void {
    this.api.stopLiveWork(id).subscribe({ next: (w) => this.put(w), error: () => undefined });
  }
}

/** The step the card shows now: the last step, or "writing the reply" once the draft started. */
export function currentStep(w: LiveWork): string {
  if (w.draft) return 'writing the reply';
  return w.steps.length ? w.steps[w.steps.length - 1] : 'reading the card';
}

/** "6 s", "1 min 4 s" from the run's start to its last report. */
export function liveDuration(w: LiveWork, now = Date.now()): string {
  const end = w.state === 'WORKING' ? now : Date.parse(w.updatedAt);
  const s = Math.max(0, Math.round((end - Date.parse(w.startedAt)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
