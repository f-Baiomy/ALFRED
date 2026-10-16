import { Injectable, signal } from '@angular/core';
import { CardSummary } from '../models/board.models';

const KEY = 'alfred.board.seen';
const MAX = 2000;

/**
 * Which cards the viewer has opened since Claude last changed them (specs/015 FR-9): a card Claude changed after the
 * viewer last opened it is unread - a dot on the card and a count in the tab title. Kept in this browser only
 * (localStorage, a viewer convenience); everything works without it, everything simply reads as seen.
 */
@Injectable({ providedIn: 'root' })
export class BoardSeenService {
  private readonly seen = signal<Readonly<Record<string, string>>>(read());

  isUnread(card: Pick<CardSummary, 'id' | 'updatedBy' | 'updatedAt'>): boolean {
    if (card.updatedBy !== 'CLAUDE') return false;
    const at = this.seen()[card.id];
    // A card never opened here is unread only when Claude changed it - and only once this browser started keeping track.
    return at === undefined ? this.trackingSince() < card.updatedAt : at < card.updatedAt;
  }

  /** When this browser last opened the card (null: never, or not tracked) - read before markSeen for "new since you looked". */
  seenAt(id: string): string | null {
    return this.seen()[id] ?? null;
  }

  markSeen(card: Pick<CardSummary, 'id' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    const at = card.updatedAt > now ? card.updatedAt : now;
    if (this.seen()[card.id] === at) return;
    const next: Record<string, string> = { ...this.seen(), [card.id]: at };
    const ids = Object.keys(next);
    if (ids.length > MAX) for (const id of ids.filter((k) => k !== '__since').slice(0, ids.length - MAX)) delete next[id];
    this.seen.set(next);
    write(next);
  }

  private trackingSince(): string {
    return this.seen()['__since'] ?? '9999';
  }
}

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
    const fresh = { __since: new Date().toISOString() };
    localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  } catch {
    return {};
  }
}

function write(value: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // private window / blocked storage: unread simply resets
  }
}
