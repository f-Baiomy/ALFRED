import { TestBed } from '@angular/core/testing';
import { BoardSeenService } from './board-seen.service';

describe('BoardSeenService', () => {
  beforeEach(() => localStorage.removeItem('alfred.board.seen'));
  afterEach(() => localStorage.removeItem('alfred.board.seen'));

  it('a card Claude changed after this browser started tracking is unread until opened', () => {
    const seen = TestBed.inject(BoardSeenService);
    const later = new Date(Date.now() + 60_000).toISOString();
    const card = { id: 'k1', updatedBy: 'CLAUDE' as const, updatedAt: later };

    expect(seen.isUnread(card)).toBeTrue();
    seen.markSeen(card);
    expect(seen.isUnread(card)).toBeFalse();
    expect(seen.isUnread({ ...card, updatedAt: new Date(Date.now() + 3_600_000).toISOString() })).toBeTrue();
  });

  it('the user\'s own changes and old cards are never unread', () => {
    const seen = TestBed.inject(BoardSeenService);
    expect(seen.isUnread({ id: 'k2', updatedBy: 'USER', updatedAt: new Date(Date.now() + 60_000).toISOString() })).toBeFalse();
    expect(seen.isUnread({ id: 'k3', updatedBy: 'CLAUDE', updatedAt: '2020-01-01T00:00:00Z' })).toBeFalse();
  });
});
