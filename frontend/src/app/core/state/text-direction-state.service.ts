import { Injectable, signal } from '@angular/core';
import { DirChoice } from '../../shared/utils/text-direction';

const KEY = 'alfred.board.textDir';

/**
 * The user's ⇄ choice per comment (auto unless changed): kept in this browser only - a way to read, not part of the
 * comment, so nobody else's view changes.
 */
@Injectable({ providedIn: 'root' })
export class TextDirectionStateService {
  private readonly choices = signal<Readonly<Record<string, DirChoice>>>(load());

  choice(key: string | number): DirChoice {
    return this.choices()[String(key)] ?? 'auto';
  }

  set(key: string | number, c: DirChoice): void {
    const next = { ...this.choices() };
    if (c === 'auto') delete next[String(key)]; else next[String(key)] = c;
    this.choices.set(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: for this page only */ }
  }
}

function load(): Record<string, DirChoice> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
