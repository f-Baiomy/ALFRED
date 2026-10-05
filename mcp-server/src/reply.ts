import { AlfredError } from './alfred-client.ts';

/**
 * Replies are sized for one conversation turn (SC-005). Nothing is ever cut silently (FR-006):
 * a list returns fewer items plus `nextOffset`, a body returns a chunk plus `totalLength` and
 * `nextOffset`, and a reply that still does not fit says so and how to ask for less.
 */
export const REPLY_BUDGET = 16_000;

export interface ToolReply {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** A tool input the server itself refuses (a missing folder, a call outside the cycle) - same shape as Alfred's 400. */
export function invalid(message: string): AlfredError {
  return new AlfredError('invalid', message);
}

export function notFound(message: string): AlfredError {
  return new AlfredError('not_found', message);
}

export function text(value: string): ToolReply {
  return { content: [{ type: 'text', text: value }] };
}

export function ok(value: unknown, prefix = ''): ToolReply {
  const json = JSON.stringify(value);
  const body = prefix ? `${prefix}\n\n${json}` : json;
  if (body.length > REPLY_BUDGET) {
    return fail(invalid(`The reply would be ${body.length} characters (limit ${REPLY_BUDGET}). Ask for a smaller page (limit), fewer fields, or a shorter bodyLength.`));
  }
  return text(body);
}

export function fail(error: unknown): ToolReply {
  const payload = error instanceof AlfredError
    ? { error: error.kind, message: error.message, ...(error.tried ? { tried: error.tried } : {}) }
    : { error: 'backend', message: (error as Error)?.message ?? String(error) };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

/** Runs a tool body, turning every thrown error into a clear error reply (FR-023). */
export async function run(work: () => Promise<ToolReply>): Promise<ToolReply> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof AlfredError)) process.stderr.write(`alfred-mcp: ${(error as Error)?.stack ?? String(error)}\n`);
    return fail(error);
  }
}

export interface BodyChunk {
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly totalLength: number;
  readonly nextOffset: number | null;
}

/**
 * `length` bounds the chunk as it travels - JSON-escaped - so a body full of quotes or newlines
 * cannot push a reply past the budget: the slice shrinks until its escaped form fits.
 */
export function chunkText(value: string, offset: number, length: number): BodyChunk {
  const start = Math.min(Math.max(0, offset), value.length);
  let end = Math.min(value.length, start + length);
  while (end > start + 1 && JSON.stringify(value.slice(start, end)).length - 2 > length) {
    end = start + Math.max(1, Math.floor((end - start) * 0.8));
  }
  const slice = value.slice(start, end);
  return { text: slice, offset: start, length: slice.length, totalLength: value.length, nextOffset: end < value.length ? end : null };
}

const BINARY_TYPES = /^(image|audio|video|font)\/|application\/(octet-stream|zip|gzip|x-gzip|pdf|x-protobuf|protobuf)/i;

/** True for a body that would only be noise as text - reported by type and size instead. */
export function isBinary(contentType: string | undefined, value: string): boolean {
  if (contentType && BINARY_TYPES.test(contentType)) return true;
  if (!value) return false;
  const sample = value.slice(0, 2000);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffd) control++;
  }
  return control / sample.length > 0.05;
}

/**
 * Takes as many items from the front as fit the budget (leaving `reserve` characters for the rest
 * of the reply), always at least one, and says where the next page starts.
 */
export function fitItems<T>(items: readonly T[], reserve: number): { items: T[]; cut: boolean } {
  const out: T[] = [];
  let size = reserve;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1;
    if (out.length > 0 && size + itemSize > REPLY_BUDGET) return { items: out, cut: true };
    out.push(item);
    size += itemSize;
  }
  return { items: out, cut: false };
}

/** A long free text (a pasted stack trace in a comment) shortened for a summary, saying how to read it all. */
export function preview(value: string, max: number, how: string): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} chars - ${how})` : value;
}
