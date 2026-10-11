import { Injectable, signal } from '@angular/core';

/** A board card to open again on the way back. */
export interface ReturnCard {
  readonly project: string;
  readonly number: number;
  readonly title: string;
}

/** The call popup that was open, to show again. Same shape as BoardMentionsService's MentionCallTarget. */
export interface ReturnPopup {
  readonly direction: 'in' | 'out';
  readonly callId: string;
  readonly cycleId: string | null;
  readonly label: string;
}

/** One scrolled element: the page itself, or the nth match of a selector (board columns, the drawer, the popup). */
export interface ScrollMark {
  readonly selector: string | null;
  readonly index: number;
  readonly top: number;
  readonly left: number;
}

/**
 * Where the user was before Alfred took them to a call: the page's URL, the card that was open, the call popup that
 * was open on top of it, and how far every scrolled area was scrolled - so "Back" puts them exactly there.
 */
export interface ReturnPoint {
  readonly url: string;
  readonly card: ReturnCard | null;
  readonly popup: ReturnPopup | null;
  /** The page, the board's columns and the drawer. */
  readonly scrolls: readonly ScrollMark[];
  /** Inside the call popup. */
  readonly popupScrolls: readonly ScrollMark[];
}

/** The areas that scroll on a board: the board's columns, the card drawer, and the call popup. */
export const PAGE_SCROLLERS = ['.board-columns', '.board-drawer-body'];
export const POPUP_SCROLLERS = ['.board-call-pop-body'];

/** How long a restore waits for the page to render what it scrolls (the card loads, the popup's call loads). */
const RESTORE_WAIT_MS = 6000;

/**
 * "Back to where I was" after a card's call popup took the user to the call (its cycle or Live Calls, pointed at) -
 * the same idea as the database window's "◆ Back to database". The card drawer says which card is open
 * (`openCard`); the jump records the point (`set`, with `captureScrolls`); ReturnPointHostComponent shows the button,
 * goes back and puts every scroll back with `restoreScrolls`.
 */
@Injectable({ providedIn: 'root' })
export class ReturnPointService {
  /** The card open in a drawer right now, if any. */
  readonly openCard = signal<ReturnCard | null>(null);
  private readonly pointSignal = signal<ReturnPoint | null>(null);
  readonly point = this.pointSignal.asReadonly();

  set(point: ReturnPoint): void {
    this.pointSignal.set(point);
  }

  clear(): void {
    this.pointSignal.set(null);
  }
}

/** The page's scroll and every scrolled match of these selectors, right now. */
export function captureScrolls(selectors: readonly string[], withPage = true): ScrollMark[] {
  const marks: ScrollMark[] = [];
  const page = document.scrollingElement;
  if (withPage && page) marks.push({ selector: null, index: 0, top: page.scrollTop, left: page.scrollLeft });
  for (const selector of selectors) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el, index) => {
      if (el.scrollTop || el.scrollLeft) marks.push({ selector, index, top: el.scrollTop, left: el.scrollLeft });
    });
  }
  return marks;
}

/**
 * Puts the scrolls back once each element exists and is tall enough to be scrolled that far - the card and the
 * popup's call load after the page, so this keeps trying (every 50 ms - not per frame, which stops in a hidden tab) for a few seconds.
 */
export function restoreScrolls(marks: readonly ScrollMark[]): Promise<void> {
  const pending = [...marks];
  const started = Date.now();
  return new Promise((resolve) => {
    const step = () => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const m = pending[i];
        const el = m.selector === null ? document.scrollingElement : document.querySelectorAll<HTMLElement>(m.selector)[m.index];
        if (!el) continue;
        const reachable = el.scrollHeight - el.clientHeight >= m.top - 1 && el.scrollWidth - el.clientWidth >= m.left - 1;
        if (!reachable) continue;
        el.scrollTop = m.top;
        el.scrollLeft = m.left;
        pending.splice(i, 1);
      }
      if (!pending.length || Date.now() - started > RESTORE_WAIT_MS) resolve();
      else setTimeout(step, 50);
    };
    step();
  });
}

/** Resolves when the selector matches (or after the wait), for "the drawer has the card loaded". */
export function whenPresent(selector: string, test: (el: HTMLElement) => boolean = () => true): Promise<HTMLElement | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const step = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && test(el)) resolve(el);
      else if (Date.now() - started > RESTORE_WAIT_MS) resolve(null);
      else setTimeout(step, 50);
    };
    step();
  });
}
