import { HttpInterceptorFn } from '@angular/common/http';

/**
 * This browser's key (specs/031): given once when it is paired with the user's helper, kept in this browser only, and
 * sent as X-Alfred-Key with every request to Alfred - so the board lock knows the writes are the user's. Storage may be
 * missing (private window, blocked site data): then the browser is simply unpaired.
 */
const KEY = 'alfred.key';

export function readKey(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveKey(key: string | null): void {
  try {
    if (key) window.localStorage.setItem(KEY, key);
    else window.localStorage.removeItem(KEY);
  } catch {
    // no storage: the browser stays unpaired
  }
}

/** Only Alfred's own origin gets the key - never a third party a request might go to. */
export function sameAlfred(url: string, backendUrl: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    return new URL(url).origin === new URL(backendUrl).origin;
  } catch {
    return false;
  }
}

export const alfredKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const key = readKey();
  const backend = window.BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:5000`;
  if (!key || !sameAlfred(req.url, backend) || req.headers.has('X-Alfred-Key')) return next(req);
  return next(req.clone({ setHeaders: { 'X-Alfred-Key': key } }));
};
