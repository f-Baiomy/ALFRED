import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { ReplaySubject, filter, firstValueFrom, map, skip } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { BoardSocketService } from './board-socket.service';

export interface AskRecord {
  readonly id: string;
  readonly state: 'OPEN' | 'ANSWERED' | 'CANCELLED';
  readonly answer: string | null;
  readonly question: string;
}

export interface AskRequest {
  readonly project?: string | null;
  readonly cycleId?: string | null;
  readonly cardId?: string | null;
  readonly snippetId?: string | null;
  readonly kind: 'SNIPPET' | 'EDITOR';
  readonly question: string;
  readonly data?: unknown;
}

/**
 * Ask Claude from the board (specs/017 R24, R38): the question goes to the cycle's chat as `/alfred-ask <id>`, and the
 * answer comes back on /ws/board's `ask:<id>` - the promise waits on that signal, never by polling. `cancel` tells
 * Alfred the asker stopped waiting (the queued run is cancelled).
 */
@Injectable({ providedIn: 'root' })
export class AskClaudeService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  /** Every ask signal of the last minute, so an answer that beats the subscription is not missed. */
  private readonly answered$ = new ReplaySubject<string>(50, 60_000);

  constructor() {
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type === 'board-changed' && e.what.startsWith('ask:')) this.answered$.next(e.what.slice(4));
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private get base(): string {
    return `${this.config.backendUrl}/board/asks`;
  }

  /** Sends the question; resolves with its id once Alfred has queued it for the chat. */
  async send(req: AskRequest): Promise<string> {
    try {
      const ask = await firstValueFrom(this.http.post<AskRecord>(this.base, req));
      return ask.id;
    } catch (e) {
      throw new Error((e as { error?: { message?: string } })?.error?.message ?? 'Could not ask Claude');
    }
  }

  /** Claude's answer to an ask; rejects if the asker cancelled or the ask is gone. */
  async answer(id: string): Promise<string> {
    for (let seen = 0; ; seen++) {
      const now = await this.get(id);
      if (now.state === 'ANSWERED') return now.answer ?? '';
      if (now.state === 'CANCELLED') throw new Error('The question was withdrawn');
      // The next signal for this ask - the replay holds the ones already read, so skip those.
      await firstValueFrom(this.answered$.pipe(filter((x) => x === id), skip(seen), map(() => undefined)));
    }
  }

  async ask(req: AskRequest): Promise<string> {
    return this.answer(await this.send(req));
  }

  cancel(id: string): void {
    this.http.post(`${this.base}/${encodeURIComponent(id)}/cancel`, {}).subscribe({ error: () => undefined });
  }

  private get(id: string): Promise<AskRecord> {
    return firstValueFrom(this.http.get<AskRecord>(`${this.base}/${encodeURIComponent(id)}`));
  }
}
