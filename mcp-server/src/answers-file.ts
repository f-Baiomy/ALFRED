import { inflateRawSync } from 'node:zlib';
import { JSDOM } from 'jsdom';

/**
 * Reads an answers file (specs/037 D15-D17, D20) on this machine, so only its answers - never the page - go to Alfred:
 * the HTML page a questions form downloads, or a .zip holding that one page. Only the
 * `<script type="application/json" id="alfred-answers">` block is read, with jsdom (scripts never run, nothing is
 * loaded) and JSON.parse. A .zip is inflated with the output capped, so an archive that grows past the limit stops at it.
 * The same rules, messages and test files as the backend's AnswersFile.java; Alfred checks the JSON again.
 */

export const MAX_BYTES = 2 * 1024 * 1024;
export const NOT_ANSWERS = 'Not an Alfred answers file';
export const TOO_BIG = 'An answers file is at most 2 MB';
export const BAD_ZIP = 'A .zip is accepted only when it holds one Alfred answers file';

export interface AnswersJson {
  readonly formId: string;
  readonly version: number;
  readonly board?: string;
  readonly answeredBy?: string;
  readonly answers: readonly unknown[];
  readonly [key: string]: unknown;
}

export class AnswersFileError extends Error {}

const FORM_ID = /^qf_[0-9a-f]{32}$/;
const ID = /^[a-z][0-9]{1,6}$/;

/** A file as read from disk: a .zip (by name or first bytes) or the html. */
export function readAnswersFile(name: string, data: Uint8Array): AnswersJson {
  if (!data.length) throw new AnswersFileError(NOT_ANSWERS);
  const zip = /\.zip$/i.test(name) || (data.length > 3 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4);
  if (data.length > MAX_BYTES) throw new AnswersFileError(TOO_BIG);
  return extractAnswers(zip ? unzipAnswers(data) : Buffer.from(data).toString('utf8'));
}

/** The machine block of an answers page, checked. */
export function extractAnswers(html: string): AnswersJson {
  if (!html || !html.trim()) throw new AnswersFileError(NOT_ANSWERS);
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) throw new AnswersFileError(TOO_BIG);
  // jsdom's defaults: no script runs, no resource is fetched
  const doc = new JSDOM(html).window.document;
  const block = doc.getElementById('alfred-answers');
  if (!block || block.tagName.toLowerCase() !== 'script' || (block.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json') {
    throw new AnswersFileError(NOT_ANSWERS);
  }
  let json: unknown;
  try {
    json = JSON.parse(block.textContent ?? '');
  } catch {
    throw new AnswersFileError(NOT_ANSWERS);
  }
  return checkAnswers(json);
}

/** The shape Alfred takes (AnswersFile.json): version 1, a form id, answers that name questions and options by id. */
export function checkAnswers(json: unknown): AnswersJson {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new AnswersFileError(NOT_ANSWERS);
  const o = json as Record<string, unknown>;
  if (o['version'] !== 1) {
    const v = o['version'] === undefined || o['version'] === null ? 'none' : String(o['version']).slice(0, 20);
    throw new AnswersFileError(`Unknown answers file version ${v}`);
  }
  if (typeof o['formId'] !== 'string' || !FORM_ID.test(o['formId']) || !Array.isArray(o['answers']) || o['answers'].length > 500) {
    throw new AnswersFileError(NOT_ANSWERS);
  }
  for (const a of o['answers'] as unknown[]) {
    const r = a as Record<string, unknown>;
    if (!r || typeof r !== 'object' || typeof r['q'] !== 'string' || !ID.test(r['q'])) throw new AnswersFileError(NOT_ANSWERS);
    if (!ids(r['choice'])) throw new AnswersFileError(NOT_ANSWERS);
    const f = r['follow'] as Record<string, unknown> | null | undefined;
    if (f && typeof f === 'object' && (typeof f['q'] !== 'string' || !ID.test(f['q']) || !ids(f['choice']))) throw new AnswersFileError(NOT_ANSWERS);
    if (typeof r['note'] === 'string' && r['note'].trim().length > 16_000) throw new AnswersFileError('A note is at most 16000 characters');
  }
  return o as unknown as AnswersJson;
}

function ids(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  return Array.isArray(v) && v.length <= 20 && v.every((c) => typeof c === 'string' && ID.test(c));
}

/** The one html page inside a .zip - by its central directory, every size counted, nothing written anywhere. */
export function unzipAnswers(data: Uint8Array): string {
  const buf = Buffer.from(data);
  // the end of central directory record: within the last 64 KB + 22 bytes
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new AnswersFileError(BAD_ZIP);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count > 20) throw new AnswersFileError(BAD_ZIP);
  let html: string | null = null;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new AnswersFileError(BAD_ZIP);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) throw new AnswersFileError(BAD_ZIP);
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || base.startsWith('._')) continue;
    if (!/\.html?$/i.test(name) || html !== null) throw new AnswersFileError(BAD_ZIP);
    if (flags & 1) throw new AnswersFileError(BAD_ZIP);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new AnswersFileError(BAD_ZIP);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let out: Buffer;
    if (method === 0) {
      out = raw;
    } else if (method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: MAX_BYTES });
      } catch (e) {
        throw new AnswersFileError((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test((e as Error).message) ? TOO_BIG : BAD_ZIP);
      }
    } else {
      throw new AnswersFileError(BAD_ZIP);
    }
    if (out.length > MAX_BYTES) throw new AnswersFileError(TOO_BIG);
    html = out.toString('utf8');
  }
  if (html === null) throw new AnswersFileError(BAD_ZIP);
  return html;
}
