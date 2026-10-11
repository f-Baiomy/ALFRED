import { Injectable, signal } from '@angular/core';

/** How an opened board card is shown: the side panel over the board, the whole page, or its own browser window. */
export type CardViewMode = 'side' | 'full' | 'window';

/** A card the board can open by number - what a window sends back when the user docks it again. */
export interface CardWindowTarget {
  readonly project: string;
  readonly cycleId: string | null;
  readonly number: number;
}

const MODE_KEY = 'alfred_card_view_mode';
const MODES: readonly CardViewMode[] = ['side', 'full', 'window'];
const CHANNEL = 'alfred-card-window';
/** How long a card window waits for a board tab to say it took the card back. */
const DOCK_ACK_MS = 400;

type ChannelMessage =
  | { readonly type: 'dock'; readonly id: string; readonly target: CardWindowTarget; readonly mode: CardViewMode }
  | { readonly type: 'docked'; readonly id: string };

/**
 * The user's choice of how a card opens (▐ Side · ⛶ Full · ↗ Window), remembered per browser like the call view.
 *
 * ↗ Window opens the card as `/board?...&card=N&window=1` in a popup; picking Side or Full there hands the card back
 * to an open board tab over a BroadcastChannel (same origin, no backend) and closes the popup. With no board tab to
 * answer, the popup becomes the board itself.
 */
@Injectable({ providedIn: 'root' })
export class CardViewModeService {
  readonly mode = signal<CardViewMode>(loadMode());

  set(mode: CardViewMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // storage full/blocked - the choice just won't survive a reload this time
    }
  }

  /** The URL a card window shows. */
  windowUrl(target: CardWindowTarget): string {
    const query = new URLSearchParams();
    if (target.project) query.set('project', target.project);
    if (target.cycleId) query.set('cycle', target.cycleId);
    query.set('card', String(target.number));
    query.set('window', '1');
    return `/board?${query}`;
  }

  /** Opens the card in its own window - one window for cards, reused, so a second card replaces the first. */
  popOut(target: CardWindowTarget): void {
    window.open(this.windowUrl(target), 'alfred-card', 'popup,width=1100,height=900');
  }

  /** From a card window: asks a board tab to open the card in `mode`. True when one answered within DOCK_ACK_MS. */
  dock(target: CardWindowTarget, mode: CardViewMode): Promise<boolean> {
    const channel = openChannel();
    if (!channel) return Promise.resolve(false);
    const id = `${Date.now()}-${Math.random()}`;
    return new Promise((resolve) => {
      const done = (answered: boolean) => {
        clearTimeout(timer);
        channel.close();
        resolve(answered);
      };
      const timer = setTimeout(() => done(false), DOCK_ACK_MS);
      channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
        if (event.data?.type === 'docked' && event.data.id === id) done(true);
      };
      channel.postMessage({ type: 'dock', id, target, mode } satisfies ChannelMessage);
    });
  }

  /**
   * In a board tab: takes cards handed back by a card window. `open` says whether it took the card - a card window
   * itself listens too (it is a board page) and must not answer its own request. Returns the stop function.
   */
  listen(open: (target: CardWindowTarget, mode: CardViewMode) => boolean): () => void {
    const channel = openChannel();
    if (!channel) return () => undefined;
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (message?.type !== 'dock' || !open(message.target, message.mode)) return;
      this.set(message.mode);
      channel.postMessage({ type: 'docked', id: message.id } satisfies ChannelMessage);
    };
    return () => channel.close();
  }
}

function loadMode(): CardViewMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.includes(stored as CardViewMode) ? (stored as CardViewMode) : 'side';
  } catch {
    return 'side';
  }
}

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
}
