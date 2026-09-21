import { Observable, timer } from 'rxjs';
import { repeat, retry } from 'rxjs/operators';
import { webSocket } from 'rxjs/webSocket';

/** How long to wait before re-opening a socket that went away, whichever way it went. */
const RECONNECT_DELAY_MS = 3000;

/**
 * The one way this app opens a WebSocket: a connection that comes back by itself, and tells its
 * caller when it did.
 *
 * `retry` alone is NOT enough, which is the bug this exists to make impossible. RxJS's `webSocket`
 * only *errors* when a connection dies abnormally (close code 1006 - a crash, a dropped network);
 * when the server closes it *cleanly* (1000/1001, which is what a graceful backend restart or
 * redeploy sends) the observable *completes* instead. `retry` ignores completion, so the
 * subscription simply ended: no error, nothing in the console, and that channel stayed deaf until
 * somebody reloaded the page. Confirmed live - closing `/ws/calls` with code 1000 left the
 * dashboard permanently frozen while its sibling `/ws/internal-calls` socket kept working, and
 * calls logged afterwards reached the backend and a fresh socket but never the open app. Every
 * list in the app is fetch-on-demand driven by one of these sockets (see
 * docs/frontend-architecture.md), so a silently dead socket means a silently dead screen.
 *
 * `onReconnect` fires on every open EXCEPT the first, so a caller can re-fetch what it missed
 * while the socket was away. Deliberately not the first open: every caller already fetches once on
 * construction, and firing there would just double it on every page load.
 */
export function reconnectingSocket<T>(url: string, onReconnect?: () => void): Observable<T> {
  let opened = false;
  return webSocket<T>({
    url,
    openObserver: {
      next: () => {
        if (opened) onReconnect?.();
        opened = true;
      },
    },
  }).pipe(
    retry({ delay: () => timer(RECONNECT_DELAY_MS) }),
    repeat({ delay: () => timer(RECONNECT_DELAY_MS) })
  );
}
