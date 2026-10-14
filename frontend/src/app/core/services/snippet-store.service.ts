import { Injectable, inject } from '@angular/core';
import { Observable, filter, firstValueFrom, map } from 'rxjs';
import { BoardSocketService } from './board-socket.service';
import { SnippetsApiService } from './snippets-api.service';

/**
 * What a snippet with an id keeps (specs/017 R23, R28, R31): its saved state - `alfred.state` - shared by everyone who
 * opens it and live through /ws/board's `state:<id>` signal; and the shot plus console Alfred keeps of each version so
 * Claude can see what it drew. One `SnippetMemory` per frame.
 */
@Injectable({ providedIn: 'root' })
export class SnippetStoreService {
  private readonly api = inject(SnippetsApiService);
  private readonly socket = inject(BoardSocketService);

  memory(id: string): SnippetMemory {
    return new SnippetMemory(id, this.api, this.socket.events$.pipe(
      filter((e) => e.type === 'board-changed' && e.what === `state:${id}`), map(() => undefined)));
  }

  /**
   * Keeps a shot of this version unless one is already kept: `take` draws it (the frame does), `consoleLines` is what
   * it logged. Quietly does nothing where the board is read-only.
   */
  async keepShot(id: string, version: number, take: () => Promise<string>, consoleLines: () => readonly string[]): Promise<boolean> {
    try {
      const kept = await firstValueFrom(this.api.shot(id, false)).catch(() => null);
      if (kept && kept.version === version) return false;
      const png = await take();
      await firstValueFrom(this.api.putShot(id, version, png, consoleLines()));
      return true;
    } catch {
      return false;
    }
  }
}

/** One snippet's saved values, read once and kept in step with what others save. */
export class SnippetMemory {
  private values: Map<string, unknown> | null = null;
  private loading: Promise<Map<string, unknown>> | null = null;

  constructor(readonly id: string, private readonly api: SnippetsApiService, readonly changes$: Observable<void>) {}

  async get(key: string): Promise<unknown> {
    return (await this.load()).get(key) ?? null;
  }

  async all(): Promise<Record<string, unknown>> {
    return Object.fromEntries(await this.load());
  }

  async set(key: string, value: unknown): Promise<unknown> {
    if (typeof key !== 'string' || !key) throw new Error('alfred.state.set needs a key');
    await firstValueFrom(this.api.putState(this.id, key, value === undefined ? null : value)).catch((e) => {
      throw new Error(e?.error?.message ?? 'Could not save');
    });
    const values = await this.load();
    if (value == null) values.delete(key);
    else values.set(key, JSON.parse(JSON.stringify(value)));
    return value ?? null;
  }

  /** Re-reads after a `state:<id>` signal and says which keys now hold something else. */
  async refresh(): Promise<{ key: string; value: unknown }[]> {
    const before = this.values ?? new Map<string, unknown>();
    this.values = null;
    this.loading = null;
    const after = await this.load();
    const changed: { key: string; value: unknown }[] = [];
    for (const [k, v] of after) if (JSON.stringify(before.get(k)) !== JSON.stringify(v)) changed.push({ key: k, value: v });
    for (const k of before.keys()) if (!after.has(k)) changed.push({ key: k, value: null });
    return changed;
  }

  private load(): Promise<Map<string, unknown>> {
    if (this.values) return Promise.resolve(this.values);
    this.loading ??= firstValueFrom(this.api.state(this.id)).then((rows) => {
      const m = new Map<string, unknown>();
      for (const r of rows) {
        try { m.set(r.key, JSON.parse(r.value)); } catch { m.set(r.key, r.value); }
      }
      this.values = m;
      return m;
    }, () => {
      this.loading = null;
      this.values = new Map();
      return this.values;
    });
    return this.loading;
  }
}

/** A stable number for an inline block's source - its shot's "version" (it has no versions of its own). */
export function sourceHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) & 0x3fffffff;
}
