/**
 * Structural grade of a finished response. Status, stable headers, and the body are one
 * MATCH or one DIFFERENT. Key order and insignificant whitespace match. A leaf that is only
 * noise does not make the response different. The bodies themselves stay on the call.
 */
import { countsAsUnexpected } from './relive-noise';
import { isGeneratedRequestHeader } from './recorded-call-match';
import { NoiseRule } from './relive-types';

const RECORDED_RESPONSE = 'recorded response';
const DIFFERENT_RESPONSE = 'different response';

export interface ResponseGradeContext {
  readonly noiseRules: readonly NoiseRule[];
  readonly variablesUsed: readonly { readonly name: string; readonly value: string }[];
  readonly variablesProduced: readonly { readonly name: string; readonly value: string }[];
}

export interface GradedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>> | null | undefined;
  readonly body: string | null | undefined;
}

/** Null when the completed response matches. Otherwise one row, without the bodies. */
export function finishedResponseDifference(
  recorded: GradedResponse,
  actual: GradedResponse,
  ctx: ResponseGradeContext,
): StructureDifference | null {
  const differs = recorded.status !== actual.status
    || stableHeadersDiffer(recorded.headers, actual.headers, ctx)
    || bodyDiffers(recorded.body, actual.body, ctx);
  if (!differs) return null;
  return { recorded: RECORDED_RESPONSE, actual: DIFFERENT_RESPONSE };
}

export interface ResponseFieldDifference {
  readonly part: 'status' | 'header' | 'body';
  readonly path: string;
  readonly recorded: string | null;
  readonly actual: string | null;
}

/** The stored grade is one collapsed row. This is that same comparison, field by field, for display. */
export function isCollapsedResponseDifference(
  diff: { readonly path: string; readonly recorded: string | null; readonly actual: string | null },
): boolean {
  return diff.path === 'response' && diff.recorded === RECORDED_RESPONSE && diff.actual === DIFFERENT_RESPONSE;
}

/** Every field that makes the response different. Noise leaves are left out. Not stored on the step. */
export function listResponseDifferences(
  recorded: GradedResponse,
  actual: GradedResponse,
  ctx: ResponseGradeContext,
): ResponseFieldDifference[] {
  const found: ResponseFieldDifference[] = [];
  if (recorded.status !== actual.status) {
    found.push({ part: 'status', path: 'status', recorded: String(recorded.status), actual: String(actual.status) });
  }
  collectHeaders(recorded.headers, actual.headers, ctx, found);
  collectBody(recorded.body, actual.body, ctx, found);
  return found;
}

function stableHeadersDiffer(
  recorded: Readonly<Record<string, string>> | null | undefined,
  actual: Readonly<Record<string, string>> | null | undefined,
  ctx: ResponseGradeContext,
): boolean {
  const left = stableHeaderMap(recorded);
  const right = stableHeaderMap(actual);
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const rec = left.get(name) ?? null;
    const act = right.get(name) ?? null;
    if (rec === act) continue;
    if (countsAsUnexpected({ part: 'header', path: name, recorded: rec, actual: act }, ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced)) {
      return true;
    }
  }
  return false;
}

function stableHeaderMap(headers: Readonly<Record<string, string>> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (isGeneratedRequestHeader(name)) continue;
    out.set(name.toLowerCase(), (value ?? '').trim());
  }
  return out;
}

function bodyDiffers(
  recorded: string | null | undefined,
  actual: string | null | undefined,
  ctx: ResponseGradeContext,
): boolean {
  if (canonicalResponseBody(recorded) === canonicalResponseBody(actual)) return false;
  const left = tryJson(recorded);
  const right = tryJson(actual);
  if (left.ok && right.ok) return hasRealJsonDifference(left.value, right.value, 'body', ctx);
  return countsAsUnexpected(
    { part: 'body', path: 'body', recorded: recorded ?? null, actual: actual ?? null },
    ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced,
  );
}

function tryJson(text: string | null | undefined): { ok: true; value: unknown } | { ok: false } {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

function hasRealJsonDifference(left: unknown, right: unknown, path: string, ctx: ResponseGradeContext): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return true;
    const count = Math.max(left.length, right.length);
    for (let i = 0; i < count; i++) {
      const child = `${path}.${i}`;
      if (i >= left.length) {
        if (!subtreeIsHarmless(right[i], child, ctx)) return true;
        continue;
      }
      if (i >= right.length) {
        if (!subtreeIsHarmless(left[i], child, ctx)) return true;
        continue;
      }
      if (hasRealJsonDifference(left[i], right[i], child, ctx)) return true;
    }
    return false;
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return true;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const child = `${path}.${key}`;
      const inLeft = Object.prototype.hasOwnProperty.call(left, key);
      const inRight = Object.prototype.hasOwnProperty.call(right, key);
      if (!inLeft) {
        if (!subtreeIsHarmless(right[key], child, ctx)) return true;
        continue;
      }
      if (!inRight) {
        if (!subtreeIsHarmless(left[key], child, ctx)) return true;
        continue;
      }
      if (hasRealJsonDifference(left[key], right[key], child, ctx)) return true;
    }
    return false;
  }
  if (Object.is(left, right)) return false;
  return countsAsUnexpected(
    { part: 'body', path, recorded: leafText(left), actual: leafText(right) },
    ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced,
  );
}

/** A missing side counts only when every leaf it would add is noise. An empty container is structural. */
function subtreeIsHarmless(value: unknown, path: string, ctx: ResponseGradeContext): boolean {
  if (Array.isArray(value)) {
    if (!value.length) return false;
    return value.every((item, index) => subtreeIsHarmless(item, `${path}.${index}`, ctx));
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) return false;
    return keys.every((key) => subtreeIsHarmless(value[key], `${path}.${key}`, ctx));
  }
  return !countsAsUnexpected(
    { part: 'body', path, recorded: leafText(value), actual: null },
    ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced,
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function leafText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function collectHeaders(
  recorded: Readonly<Record<string, string>> | null | undefined,
  actual: Readonly<Record<string, string>> | null | undefined,
  ctx: ResponseGradeContext,
  found: ResponseFieldDifference[],
): void {
  const left = stableHeaderMap(recorded);
  const right = stableHeaderMap(actual);
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const rec = left.get(name) ?? null;
    const act = right.get(name) ?? null;
    if (rec === act) continue;
    const diff: ResponseFieldDifference = { part: 'header', path: name, recorded: rec, actual: act };
    if (countsAsUnexpected(diff, ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced)) found.push(diff);
  }
}

function collectBody(
  recorded: string | null | undefined,
  actual: string | null | undefined,
  ctx: ResponseGradeContext,
  found: ResponseFieldDifference[],
): void {
  if (canonicalResponseBody(recorded) === canonicalResponseBody(actual)) return;
  const left = tryJson(recorded);
  const right = tryJson(actual);
  if (left.ok && right.ok) {
    collectJson(left.value, right.value, 'body', ctx, found);
    return;
  }
  const diff: ResponseFieldDifference = { part: 'body', path: 'body', recorded: recorded ?? null, actual: actual ?? null };
  if (countsAsUnexpected(diff, ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced)) found.push(diff);
}

function collectJson(left: unknown, right: unknown, path: string, ctx: ResponseGradeContext, found: ResponseFieldDifference[]): void {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      found.push({ part: 'body', path, recorded: jsonText(left), actual: jsonText(right) });
      return;
    }
    const count = Math.max(left.length, right.length);
    for (let i = 0; i < count; i++) {
      const child = `${path}.${i}`;
      if (i >= left.length) collectMissing(right[i], child, ctx, found, 'actual');
      else if (i >= right.length) collectMissing(left[i], child, ctx, found, 'recorded');
      else collectJson(left[i], right[i], child, ctx, found);
    }
    return;
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      found.push({ part: 'body', path, recorded: jsonText(left), actual: jsonText(right) });
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const child = `${path}.${key}`;
      const inLeft = Object.prototype.hasOwnProperty.call(left, key);
      const inRight = Object.prototype.hasOwnProperty.call(right, key);
      if (!inLeft) collectMissing(right[key], child, ctx, found, 'actual');
      else if (!inRight) collectMissing(left[key], child, ctx, found, 'recorded');
      else collectJson(left[key], right[key], child, ctx, found);
    }
    return;
  }
  if (Object.is(left, right)) return;
  const recorded = leafText(left);
  const actual = leafText(right);
  if (!countsAsUnexpected({ part: 'body', path, recorded, actual }, ctx.noiseRules, ctx.variablesUsed, ctx.variablesProduced)) return;
  found.push({ part: 'body', path, recorded, actual });
}

/**
 * A whole branch that exists on only one side is one row. Listing every field inside a missing
 * offer made one response look like dozens of differences. A noise-only branch stays out.
 */
function collectMissing(
  value: unknown,
  path: string,
  ctx: ResponseGradeContext,
  found: ResponseFieldDifference[],
  present: 'recorded' | 'actual',
): void {
  if (subtreeIsHarmless(value, path, ctx)) return;
  pushSide(path, present, jsonText(value), found);
}

function pushSide(path: string, present: 'recorded' | 'actual', text: string | null, found: ResponseFieldDifference[]): void {
  found.push({
    part: 'body',
    path,
    recorded: present === 'recorded' ? text : null,
    actual: present === 'actual' ? text : null,
  });
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}


const RECORDED_STRUCTURE = 'recorded structure';
const ACTUAL_STRUCTURE = 'different structure';

export interface StructureDifference {
  readonly recorded: string;
  readonly actual: string;
}

/** Null when the two bodies are the same structure. Otherwise one body-level difference. */
export function responseStructureDifference(
  recorded: string | null | undefined,
  actual: string | null | undefined,
): StructureDifference | null {
  if (canonicalResponseBody(recorded) === canonicalResponseBody(actual)) return null;
  return { recorded: RECORDED_STRUCTURE, actual: ACTUAL_STRUCTURE };
}

export function canonicalResponseBody(text: string | null | undefined): string {
  const raw = text ?? '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(sortJson(JSON.parse(trimmed)));
    } catch {
      // Not JSON. Fall through to XML or plain text.
    }
  }
  if (trimmed.startsWith('<')) {
    const xml = canonicalXml(trimmed);
    if (xml != null) return xml;
  }
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalXml(text: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  if (/<!DOCTYPE/i.test(text.slice(0, 800))) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const root = doc.documentElement;
  if (!root) return null;
  return renderXml(root);
}

function renderXml(el: Element): string {
  const attrs = Array.from(el.attributes)
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const attrText = attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
  let inner = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      inner += renderXml(node as Element);
    } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      const text = (node.textContent ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (text) inner += escapeText(text);
    }
  }
  return `<${el.tagName}${attrText}>${inner}</${el.tagName}>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
