import { Injectable, signal } from '@angular/core';
import { BannerTone } from '../../shared/components/banner/banner.component';

export interface BoardBanner {
  readonly tone: BannerTone;
  readonly text: string;
  readonly detail?: string | null;
  readonly action?: string | null;
  readonly onAction?: () => void;
  /** The board it is about: switching boards hides it. */
  readonly boardId?: string | null;
  /** Replaced by a later banner of the same key (Pause's "waiting" by its "paused"). */
  readonly key?: string;
  /** False for a line that ends by itself (a Pause still waiting for the PC). */
  readonly dismissable?: boolean;
}

/**
 * The board page's one result line (specs/032 D6/D9): what Pause, Hand back, Refresh from Azure and the Next card just did,
 * shown under the header. One at a time - a newer one replaces it - and dismissed by the user, never by a timer.
 */
@Injectable({ providedIn: 'root' })
export class BoardBannerService {
  readonly current = signal<BoardBanner | null>(null);

  show(b: BoardBanner): void {
    this.current.set(b);
  }

  /** Clears the banner, or only one of this key (a flow ending without saying more). */
  clear(key?: string): void {
    if (!key || this.current()?.key === key) this.current.set(null);
  }
}
