/**
 * Alfred's existing HTTP API, through the gateway - the same endpoints the Angular UI calls. Never a
 * new endpoint (FR-022). Every request is bounded: a 4 s timeout (an unreachable Alfred is reported
 * well inside SC-006's 5 s) and at most four in flight, so one tool fanning out over a cycle cannot
 * flood a backend that is also recording live traffic.
 */

export type AlfredErrorKind = 'unreachable' | 'not_found' | 'invalid' | 'backend';

export class AlfredError extends Error {
  constructor(
    readonly kind: AlfredErrorKind,
    message: string,
    readonly status?: number,
    readonly tried?: string,
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

export class AlfredClient {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly baseUrl: string = alfredUrl()) {}

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
        headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }),
          ...(options.headers ?? {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      throw new AlfredError('unreachable',
        `Alfred is not reachable at ${this.baseUrl} (${(error as Error).name === 'TimeoutError' ? `no answer within ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)} s` : (error as Error).message}). `
        + 'Start it with `python3 start.py` in the Alfred repo, or set ALFRED_URL.', undefined, `${method} ${url.pathname}`);
    } finally {
      this.release();
    }
    if (response.status === 404) {
      throw new AlfredError('not_found', options.notFound ?? `Not found: ${url.pathname}`, 404, `${method} ${url.pathname}`);
    }
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      throw new AlfredError('invalid', `Alfred rejected the request (${response.status}): ${await safeText(response)}`, response.status, `${method} ${url.pathname}`);
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new AlfredError('unreachable',
        `Alfred's gateway answered ${response.status}: the backend is down or restarting. After a backend rebuild, \`docker compose restart app-gateway\` clears a stale upstream.`,
        response.status, `${method} ${url.pathname}`);
    }
    if (!response.ok) {
      throw new AlfredError('backend', `Alfred answered ${response.status}: ${await safeText(response)}`, response.status, `${method} ${url.pathname}`);
    }
    const text = await response.text();
    if (options.text) return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
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

/** An error body, shortened - it is shown to Claude, and Alfred's errors never carry call data worth more than this. */
async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // A refusal that explains itself ({error, message} - the task board's) is passed on as its message alone, word for word.
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed?.message === 'string' && parsed.message) return parsed.message;
    } catch {
      // not JSON: the text itself
    }
    return text.slice(0, 300);
  } catch {
    return '(no body)';
  }
}
