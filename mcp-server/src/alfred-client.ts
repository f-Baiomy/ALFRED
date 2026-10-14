/**
 * Alfred's existing HTTP API, through the gateway - the same endpoints the Angular UI calls. Never a
 * new endpoint (FR-022). Every request is bounded: a 4 s timeout (an unreachable Alfred is reported
 * well inside SC-006's 5 s) and at most four in flight, so one tool fanning out over a cycle cannot
 * flood a backend that is also recording live traffic.
 */

import { isHtml, textAsMarkdown } from './frontend.ts';

export type AlfredErrorKind = 'unreachable' | 'not_found' | 'invalid' | 'backend';

export class AlfredError extends Error {
  constructor(
    readonly kind: AlfredErrorKind,
    message: string,
    readonly status?: number,
    readonly tried?: string,
    /** The backend's own error code - the `error` of a `{error, message}` body ("paused", "duplicate-of-closed"...), when it sent one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface RequestOptions {
  readonly query?: Query;
  readonly body?: unknown;
  /** What a 404 means for this request, e.g. "call abc not found" - the default names only the path. */
  readonly notFound?: string;
  /** Longer than the default only for a known-large answer (a Relive run with its whole definition is megabytes). */
  readonly timeoutMs?: number;
  /** Extra request headers - the board's tools say who is asking (`X-Alfred-Actor: claude`, specs/014-task-board). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The answer is text (a spec file), not JSON. */
  readonly text?: boolean;
  /** A plain-text request body (a spec file's content), sent as text/plain instead of JSON. */
  readonly rawBody?: string;
}

const TIMEOUT_MS = 4000;
const MAX_IN_FLIGHT = 4;

export function alfredUrl(): string {
  return (process.env['ALFRED_URL'] || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Path segment escaping - ids come from the conversation, never trusted to be URL-safe. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** How often the offset to Alfred's clock is measured again. */
const CLOCK_REFRESH_MS = 60_000;

export class AlfredClient {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  /** Alfred's clock minus this machine's, from the Date header of an answer; 0 until the first answer. */
  private clockOffsetMs = 0;
  private clockSetAt = 0;

  constructor(readonly baseUrl: string = alfredUrl()) {}

  /**
   * Alfred's current time. A call's timestamp is Alfred's clock; with Alfred on another machine (a LAN host, a tunnel) this
   * machine's clock can be minutes off, and "how long ago did it end" must not depend on that. The Date header has a
   * resolution of one second, so this is exact to about that.
   */
  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /** The first answer sets the offset, and one a minute later renews it (a clock that drifts, or was corrected). */
  private noteClock(response: Response): void {
    const sent = Date.parse(response.headers.get('date') ?? '');
    if (Number.isNaN(sent)) return;
    const local = Date.now();
    if (this.clockSetAt && local - this.clockSetAt < CLOCK_REFRESH_MS) return;
    // The header is the second the answer was written in: its middle is the best guess of the moment. A difference
    // inside the header's own resolution is no difference (Alfred on this machine): then now() is exactly Date.now().
    const offset = sent + 500 - local;
    this.clockOffsetMs = Math.abs(offset) < 2_000 ? 0 : offset;
    this.clockSetAt = local;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  del<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /** Runs `work` over `items` with the client's own concurrency limit, keeping input order. */
  async mapLimited<I, O>(items: readonly I[], work: (item: I) => Promise<O>): Promise<O[]> {
    return Promise.all(items.map((item) => work(item)));
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    await this.acquire();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...(options.rawBody !== undefined ? { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'application/json' }
          : options.body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }),
          ...(options.headers ?? {}) },
        body: options.rawBody !== undefined ? options.rawBody : options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      throw new AlfredError('unreachable',
        `Alfred is not reachable at ${this.baseUrl} (${(error as Error).name === 'TimeoutError' ? `no answer within ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)} s` : (error as Error).message}). `
        + 'Start it with `python3 start.py` in the Alfred repo, or set ALFRED_URL.', undefined, `${method} ${url.pathname}`);
    } finally {
      this.release();
    }
    this.noteClock(response);
    if (response.status === 404) {
      throw new AlfredError('not_found', options.notFound ?? `Not found: ${url.pathname}`, 404, `${method} ${url.pathname}`);
    }
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      const body = await readError(response);
      throw new AlfredError('invalid', `Alfred rejected the request (${response.status}): ${body.message}`, response.status, `${method} ${url.pathname}`, body.code);
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new AlfredError('unreachable',
        `Alfred's gateway answered ${response.status}: the backend is down or restarting. After a backend rebuild, \`docker compose restart app-gateway\` clears a stale upstream.`,
        response.status, `${method} ${url.pathname}`);
    }
    if (!response.ok) {
      const body = await readError(response);
      throw new AlfredError('backend', `Alfred answered ${response.status}: ${body.message}`, response.status, `${method} ${url.pathname}`, body.code);
    }
    const text = await response.text();
    // The board's texts may be rich text (HTML): Claude reads them as compact Markdown, the form it writes (docs/board.md).
    const board = url.pathname.startsWith('/board/');
    if (options.text) return (board ? readableText(text) : text) as T;
    const parsed = text ? JSON.parse(text) : undefined;
    return (board ? readable(parsed) : parsed) as T;
  }

  /** A stored file as bytes (a board picture), with its type. */
  async bytes(path: string): Promise<{ mime: string; data: Buffer }> {
    const url = new URL(this.baseUrl + path);
    await this.acquire();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new AlfredError('unreachable', `Alfred is not reachable at ${this.baseUrl} (${(error as Error).message}).`, undefined, `GET ${url.pathname}`);
    } finally {
      this.release();
    }
    if (response.status === 404) throw new AlfredError('not_found', `Not found: ${url.pathname}`, 404, `GET ${url.pathname}`);
    if (!response.ok) throw new AlfredError('backend', `Alfred answered ${response.status}`, response.status, `GET ${url.pathname}`);
    return { mime: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0], data: Buffer.from(await response.arrayBuffer()) };
  }

  private acquire(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => {
      this.inFlight++;
      resolve();
    }));
  }

  private release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}

/**
 * An error body, shortened - it is shown to Claude, and Alfred's errors never carry call data worth more than this - and the
 * code the backend sent with it, so a caller can tell a paused board from a dismissed duplicate without reading the words.
 */
async function readError(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const text = await response.text();
    // A refusal that explains itself ({error, message} - the task board's) is passed on as its message alone, word for word.
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const code = typeof parsed?.error === 'string' && parsed.error ? parsed.error.slice(0, 100) : undefined;
      if (typeof parsed?.message === 'string' && parsed.message) return { message: parsed.message, code };
      return { message: text.slice(0, 300), code };
    } catch {
      // not JSON: the text itself
    }
    return { message: text.slice(0, 300) };
  } catch {
    return { message: '(no body)' };
  }
}

function readableText(text: string): string {
  return isHtml(text) ? textAsMarkdown(text) : text;
}

/** Every rich text (HTML) string of a board answer turned into Markdown; everything else as it came. */
export function readable(value: unknown): unknown {
  if (typeof value === 'string') return readableText(value);
  if (Array.isArray(value)) return value.map(readable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, readable(v)]));
  }
  return value;
}
