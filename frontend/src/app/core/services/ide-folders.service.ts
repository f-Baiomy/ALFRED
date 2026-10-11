import { Injectable, signal } from '@angular/core';

const KEY = 'alfred_ide_source_folders';

/**
 * Where each project's sources are on THIS computer - the one opening Alfred, not the Alfred server (which may be
 * another machine) - so "VS Code ↗" can open a file by its full path. Kept in this browser only; every computer has
 * its own. Several folders per project for a multi-module build.
 */
@Injectable({ providedIn: 'root' })
export class IdeFoldersService {
  readonly folders = signal<Readonly<Record<string, readonly string[]>>>(load());

  of(project: string | null | undefined): readonly string[] {
    return this.folders()[project ?? ''] ?? [];
  }

  set(project: string, folders: readonly string[]): void {
    const clean = folders.map((f) => f.trim()).filter(Boolean);
    const next = { ...this.folders() };
    if (clean.length) next[project] = clean;
    else delete next[project];
    this.folders.set(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage blocked - kept for this visit only
    }
  }
}

function load(): Record<string, readonly string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
