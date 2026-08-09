import { Injectable, signal } from '@angular/core';
import { DEFAULT_THEME, THEMES, ThemeId } from '../models/theme.model';

const STORAGE_KEY = 'alfred-theme';

/**
 * Applies the chosen theme app-wide via a `data-theme` attribute on `<html>` - every theme's
 * colors live as a CSS variable block in styles.scss keyed off that attribute, so switching
 * themes is just changing one attribute, not touching any component.
 *
 * Persisted in localStorage rather than tied to a user account - this app has no login, so
 * "the user's theme" really means "this browser's theme"; a different browser or a cleared
 * localStorage starts back at the default.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<ThemeId>(readStoredTheme());

  constructor() {
    applyThemeAttribute(this.theme());
  }

  setTheme(id: ThemeId): void {
    this.theme.set(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyThemeAttribute(id);
  }
}

function readStoredTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isThemeId(stored) ? stored : DEFAULT_THEME;
}

function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function applyThemeAttribute(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
}
