/**
 * Wraps the global fetch for the requests a test sends to ONE fake Alfred: records each with the timeout it was given (the tools'
 * own AlfredClient asks `AbortSignal.timeout(ms)`), the order requests start and end in, and - when a hook says so - delays one or
 * fails it the way a dropped connection does. Everything else (the MCP transport of `npm run test:http`) passes through.
 */

export interface TapRequest { readonly method: string; readonly path: string; readonly body: any }

/** What to do with one request: wait `delayMs` first; `fail: 'before'` throws a timeout without sending it, `'after'` sends it and then throws one. */
export interface TapAction { readonly delayMs?: number; readonly fail?: 'before' | 'after' }

export interface TappedCall { readonly method: string; readonly path: string; readonly timeoutMs: number | undefined }

export interface Tap {
  readonly calls: TappedCall[];
  /** "start GET /x" / "end GET /x", in the order they happened. */
  readonly events: string[];
  /** The timeout the request to `path` was given. */
  timeoutOf(method: string, path: string): number | undefined;
  restore(): void;
}

function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

export function tapFetch(baseUrl: string, hook?: (request: TapRequest) => TapAction | undefined): Tap {
  const origin = new URL(baseUrl).origin;
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const timeouts = new WeakMap<AbortSignal, number>();
  const calls: TappedCall[] = [];
  const events: string[] = [];
  AbortSignal.timeout = (ms: number) => {
    const signal = realTimeout.call(AbortSignal, ms);
    timeouts.set(signal, ms);
    return signal;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : (input as Request).url);
    if (url.origin !== origin) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string' && init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method, path: url.pathname, timeoutMs: init?.signal ? timeouts.get(init.signal as AbortSignal) : undefined });
    events.push(`start ${method} ${url.pathname}`);
    const action = hook?.({ method, path: url.pathname, body });
    if (action?.delayMs) await new Promise((resolve) => setTimeout(resolve, action.delayMs));
    if (action?.fail === 'before') {
      events.push(`end ${method} ${url.pathname}`);
      throw timeoutError();
    }
    const response = await realFetch(input, init);
    events.push(`end ${method} ${url.pathname}`);
    if (action?.fail === 'after') {
      await response.body?.cancel();
      throw timeoutError();
    }
    return response;
  }) as typeof fetch;
  return {
    calls,
    events,
    timeoutOf: (method, path) => calls.find((c) => c.method === method && c.path === path)?.timeoutMs,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}
