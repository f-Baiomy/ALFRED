import { Injectable } from '@angular/core';

/**
 * What the /edit tab edits. `value` is the text itself for a body; for headers it is
 * `serializeHeaderRows(rows)` (see shared/utils/header-rows.ts) - the full row list, removed rows
 * included - and every value posted back is in that same form, so the opener reads it with
 * `parseHeaderRows`.
 */
export interface EditTabSeed {
  readonly kind: 'body' | 'headers';
  readonly title: string;
  readonly value: string;
}

/** What travels on the channel from the /edit tab back to whoever opened it. */
export type EditTabMessage = { readonly type: 'value'; readonly value: string } | { readonly type: 'closed' };

export interface EditTabHandlers {
  /** Every edit made in the tab, as the whole current value (not a diff). */
  readonly value?: (value: string) => void;
  /** The tab pressed Done. It may still be open a moment longer; nothing more will arrive. */
  readonly closed?: () => void;
}

/** Deterministic from the caller's key, so opening the same thing twice reuses one slot. */
export function editTabStorageKey(key: string): string {
  return `alfred_edit_tab_${key}`;
}

export function editTabChannelName(key: string): string {
  return `alfred_edit_tab_${key}`;
}

/**
 * "Open in a big tab" for the body and header editors: the same editor, a whole window of it.
 *
 * Seeded exactly like the /view tab (see PanelViewLauncherService): the seed goes into
 * sessionStorage, which the browser clones into a same-origin tab opened with window.open, so
 * nothing needs a backend round trip. Unlike /view this one EDITS, so it also streams every change
 * back over a BroadcastChannel named after the key - the same cross-tab mechanism CommentsStore
 * uses - and the opener applies each one as if it had been typed in place.
 *
 * The key is the caller's to choose and must identify the thing being edited (a paused call's
 * half, a rule's answer...). Two openers listening on one key would both receive the edits.
 */
@Injectable({ providedIn: 'root' })
export class EditTabService {
  open(key: string, seed: EditTabSeed): void {
    this.store(key, seed);
    window.open(`/edit?key=${encodeURIComponent(key)}`, '_blank');
  }

  /**
   * Writes the seed for `key`. The /edit tab re-stores its latest value here too, so reloading
   * that tab brings back the edit in progress rather than the value it was opened with.
   */
  store(key: string, seed: EditTabSeed): void {
    sessionStorage.setItem(editTabStorageKey(key), JSON.stringify(seed));
  }

  /**
   * Hears the tab opened for `key`. Pass a function for edits only, or `{ value, closed }` for
   * both. Returns the unsubscribe - call it when the opener goes away, or the channel stays open.
   */
  listen(key: string, handlers: ((value: string) => void) | EditTabHandlers): () => void {
    const { value, closed } = typeof handlers === 'function' ? { value: handlers, closed: undefined } : handlers;
    const channel = new BroadcastChannel(editTabChannelName(key));
    channel.addEventListener('message', (event: MessageEvent<EditTabMessage>) => {
      const message = event.data;
      if (message?.type === 'value' && typeof message.value === 'string') value?.(message.value);
      else if (message?.type === 'closed') closed?.();
    });
    return () => channel.close();
  }

  /** The seed the opener left for `key`, or null once it is gone (a reloaded or copied URL). */
  readSeed(key: string): EditTabSeed | null {
    const stored = sessionStorage.getItem(editTabStorageKey(key));
    if (stored === null) return null;
    try {
      const seed = JSON.parse(stored) as Partial<EditTabSeed>;
      if ((seed.kind === 'body' || seed.kind === 'headers') && typeof seed.value === 'string') {
        return { kind: seed.kind, title: typeof seed.title === 'string' ? seed.title : '', value: seed.value };
      }
    } catch {
      // Fall through - a mangled seed is as good as none.
    }
    return null;
  }

  /** The /edit tab's side of the channel: post edits and "closed" back to the opener. */
  publisher(key: string): { post: (message: EditTabMessage) => void; close: () => void } {
    const channel = new BroadcastChannel(editTabChannelName(key));
    return { post: (message) => channel.postMessage(message), close: () => channel.close() };
  }
}
