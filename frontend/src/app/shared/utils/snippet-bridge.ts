/**
 * The host side of a snippet's channel (specs/017 R12). One bridge per frame. A message counts only when it comes from
 * THAT frame's window (`event.source`), carries `alfred: 1` and has a known shape - anything else is dropped without a
 * word, so another frame, another tab or a browser extension cannot speak for a snippet. At most 50 messages a second
 * are read; an answer bigger than 5 MB is refused instead of sent.
 */
export type SnippetOp = 'data' | 'state.get' | 'state.set' | 'state.all' | 'action' | 'ask' | 'files' | 'lib';

export const SNIPPET_OPS: readonly SnippetOp[] = ['data', 'state.get', 'state.set', 'state.all', 'action', 'ask', 'files', 'lib'];
export const MAX_MESSAGES_PER_SECOND = 50;
export const MAX_ANSWER_BYTES = 5 * 1024 * 1024;

export type SnippetMessage =
  | { t: 'ready' }
  | { t: 'size'; h: number }
  | { t: 'log'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string }
  | { t: 'shot'; id: number; png?: string; error?: string }
  | { t: 'req'; id: number; op: SnippetOp; args: Record<string, unknown> | null };

export type SnippetHandler = (op: SnippetOp, args: Record<string, unknown>) => Promise<unknown>;

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

/** The shape check, kept apart so the security spec can feed it anything. */
export function readMessage(data: unknown): SnippetMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m['alfred'] !== 1 || typeof m['t'] !== 'string') return null;
  switch (m['t']) {
    case 'ready': return { t: 'ready' };
    case 'size': return typeof m['h'] === 'number' && Number.isFinite(m['h']) ? { t: 'size', h: m['h'] as number } : null;
    case 'log':
      return LEVELS.includes(m['level'] as string) && typeof m['text'] === 'string'
        ? { t: 'log', level: m['level'] as 'log', text: (m['text'] as string).slice(0, 4000) } : null;
    case 'shot':
      if (!Number.isInteger(m['id'])) return null;
      if (typeof m['png'] === 'string' && (m['png'] as string).startsWith('data:image/png;base64,')) return { t: 'shot', id: m['id'] as number, png: m['png'] as string };
      return { t: 'shot', id: m['id'] as number, error: typeof m['error'] === 'string' ? (m['error'] as string).slice(0, 500) : 'No picture' };
    case 'req': {
      if (!Number.isInteger(m['id']) || !SNIPPET_OPS.includes(m['op'] as SnippetOp)) return null;
      const args = m['args'];
      if (args !== null && (typeof args !== 'object' || Array.isArray(args))) return null;
      return { t: 'req', id: m['id'] as number, op: m['op'] as SnippetOp, args: (args as Record<string, unknown>) ?? null };
    }
    default: return null;
  }
}

export interface SnippetBridgeEvents {
  ready?: () => void;
  size?: (h: number) => void;
  log?: (level: string, text: string) => void;
}

export class SnippetBridge {
  private count = 0;
  private windowStart = 0;
  private shotSeq = 0;
  private readonly shots = new Map<number, (r: { png?: string; error?: string }) => void>();
  private readonly listener = (e: MessageEvent) => this.receive(e);

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly handler: SnippetHandler,
    private readonly events: SnippetBridgeEvents,
    private readonly win: Window = window,
  ) {
    win.addEventListener('message', this.listener);
  }

  close(): void {
    this.win.removeEventListener('message', this.listener);
    for (const done of this.shots.values()) done({ error: 'Closed' });
    this.shots.clear();
  }

  /** Host → frame. The frame's origin is opaque, so '*' is the only target there is; it is that frame's window. */
  send(msg: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage({ ...msg, alfred: 1 }, '*');
  }

  pause(paused: boolean): void {
    this.send({ t: paused ? 'pause' : 'resume' });
  }

  emit(name: string, value: unknown): void {
    this.send({ t: 'event', name, value });
  }

  /**
   * A PNG of what the frame shows (drawn inside the frame, since nothing outside may read it). `scale` 1 for the picture
   * Alfred keeps (a quarter of the pixels of a 2x screen to draw and encode); a download leaves it to the screen.
   */
  shot(timeoutMs = 15000, scale?: number): Promise<string> {
    const id = ++this.shotSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.shots.delete(id); reject(new Error('The snippet did not answer')); }, timeoutMs);
      this.shots.set(id, (r) => { clearTimeout(timer); this.shots.delete(id); if (r.png) resolve(r.png); else reject(new Error(r.error ?? 'No picture')); });
      this.send(scale ? { t: 'shot', id, scale } : { t: 'shot', id });
    });
  }

  /** Exposed for the security spec; the window listener calls it. */
  receive(e: Pick<MessageEvent, 'source' | 'data'>): boolean {
    if (!this.frame.contentWindow || e.source !== this.frame.contentWindow) return false;
    const now = Date.now();
    if (now - this.windowStart >= 1000) { this.windowStart = now; this.count = 0; }
    if (++this.count > MAX_MESSAGES_PER_SECOND) return false;
    const m = readMessage(e.data);
    if (!m) return false;
    switch (m.t) {
      case 'ready': this.events.ready?.(); break;
      case 'size': this.events.size?.(m.h); break;
      case 'log': this.events.log?.(m.level, m.text); break;
      case 'shot': this.shots.get(m.id)?.(m); break;
      case 'req': void this.answer(m.id, m.op, m.args ?? {}); break;
    }
    return true;
  }

  private async answer(id: number, op: SnippetOp, args: Record<string, unknown>): Promise<void> {
    try {
      const value = await this.handler(op, args);
      const size = JSON.stringify(value ?? null).length;
      if (size > MAX_ANSWER_BYTES) {
        this.send({ t: 'res', id, ok: false, error: `The answer is ${Math.round(size / 1048576)} MB - ask for less (limit 5 MB)` });
        return;
      }
      this.send({ t: 'res', id, ok: true, value: value ?? null });
    } catch (err) {
      this.send({ t: 'res', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
