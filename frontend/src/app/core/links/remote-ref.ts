import { signal } from '@angular/core';
/**
 * Refs to another Alfred's things (specs/035 R1): the owner's own id, then `@<slug>` of the link it is reached through -
 * `8f1c…@stg-83`. Read through a second link, a ref gets a second suffix; the outermost is the link used here. A slug is
 * lower-case letters, digits and '-', at most 24 characters - so an e-mail address or a board's own `in:<call>@<cycle>`
 * (a cycle id is far longer) is never mistaken for one.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

export interface RefSplit {
  readonly inner: string;
  readonly slug: string;
}

export function splitRef(value: string | null | undefined): RefSplit | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const slug = value.slice(at + 1);
  if (!SLUG.test(slug)) return null;
  return { inner: value.slice(0, at), slug };
}

/** The slug a ref is reached through, when it names one of `knownSlugs` (null for this Alfred's own things). */
export function originOf(value: string | null | undefined, knownSlugs?: ReadonlySet<string>): string | null {
  const s = splitRef(value);
  if (!s) return null;
  return !knownSlugs || knownSlugs.has(s.slug) ? s.slug : null;
}

export function isRemoteRef(value: string | null | undefined, knownSlugs?: ReadonlySet<string>): boolean {
  return originOf(value, knownSlugs) !== null;
}

/**
 * The slugs of this Alfred's links, kept current by LinksStateService: a two-part board call ref `in:<call>@<x>` is a
 * call of this Alfred's cycle `<x>` unless `<x>` is one of them - then it is a live call of that Alfred.
 */
let known: ReadonlySet<string> = new Set();

export function setKnownSlugs(slugs: ReadonlySet<string>): void {
  known = slugs;
}

export function isKnownSlug(slug: string): boolean {
  return known.has(slug);
}

let names: ReadonlyMap<string, string> = new Map();

/** The names of the things other Alfreds stream here (ref -> name), kept current by LinksStateService. */
export const streamedNames = signal<ReadonlyMap<string, string>>(new Map());

/** The names this Alfred gave its links (slug -> name), kept current by LinksStateService. */
export function setKnownNames(byslug: ReadonlyMap<string, string>): void {
  names = byslug;
}

/**
 * Who "the user" is in the history of a thing: this browser's user ("You") for this Alfred's own, the owning Alfred's
 * name for another Alfred's card, board or brief - its people wrote it, not you.
 */
export function userLabel(ownerRef: string | null | undefined): string {
  const s = splitRef(ownerRef);
  return s && known.has(s.slug) ? names.get(s.slug) ?? s.slug : 'You';
}

export function withOrigin(id: string, slug: string): string {
  return `${id}@${slug}`;
}

/** The id with every link suffix off: what the owner itself calls it. */
export function localPart(value: string): string {
  let v = value;
  let s: RefSplit | null;
  while ((s = splitRef(v))) v = s.inner;
  return v;
}

/**
 * A board call ref for a call of a remote cycle: the owner's `in:<call>@<cycle>` with the cycle's link suffix(es) at the
 * end, the form the owner's own text uses once tagged (`in:<call>@<cycle>@<slug>`).
 */
export function remoteCallRef(direction: 'in' | 'out', callId: string, cycleRef: string): string {
  const call = localPart(callId);
  const cycle = localPart(cycleRef);
  const suffix = cycleRef.slice(cycle.length);
  return `${direction}:${call}@${cycle}${suffix}`;
}
