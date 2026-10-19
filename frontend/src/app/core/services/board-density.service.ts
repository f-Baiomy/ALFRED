import { Injectable, signal } from '@angular/core';

/** How the board draws its cards: Compact (a few lines, the rest in the hover peek) or Comfortable (every detail on the tile). */
export type BoardDensity = 'compact' | 'comfortable';

const KEY = 'alfred.board.density';

/** The board's density, kept in this browser only - a way to read the board, so nobody else's view changes. */
@Injectable({ providedIn: 'root' })
export class BoardDensityService {
  readonly density = signal<BoardDensity>(load());

  set(d: BoardDensity): void {
    this.density.set(d);
    try { localStorage.setItem(KEY, d); } catch { /* private mode: for this page only */ }
  }
}

function load(): BoardDensity {
  try {
    return localStorage.getItem(KEY) === 'comfortable' ? 'comfortable' : 'compact';
  } catch {
    return 'compact';
  }
}
