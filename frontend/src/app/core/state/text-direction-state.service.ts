import { Injectable, signal } from '@angular/core';
import { DirChoice } from '../../shared/utils/text-direction';

const KEY = 'alfred.board.textDir';
const WRAP_KEY = 'alfred.board.wrap';

/**
 * The user's ⇄ choice per comment (auto unless changed) and its wrap / scroll choice (scroll unless changed): kept in this browser only - a way to read, not part of the
 * comment, so nobody else's view changes.
 */
@Injectable({ providedIn: 'root' })
export class TextDirectionStateService {
  private readonly choices = signal<Readonly<Record<string, DirChoice>>>(load(KEY));
  /** Comments read with long lines wrapped; every other one keeps lines whole and scrolls tables and code sideways. */
  private readonly wrapped = signal<Readonly<Record<string, true>>>(load(WRAP_KEY) as unknown as Record<string, true>);

  wraps(key: string | number): boolean {
    return !!this.wrapped()[String(key)];
  }

  toggleWrap(key: string | number): void {
    const next = { ...this.wrapped() };
    if (next[String(key)]) delete next[String(key)]; else next[String(key)] = true;
    this.wrapped.set(next);
    try { localStorage.setItem(WRAP_KEY, JSON.stringify(next)); } catch { /* private mode: for this page only */ }
  }

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

function load(key: string): Record<string, DirChoice> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
