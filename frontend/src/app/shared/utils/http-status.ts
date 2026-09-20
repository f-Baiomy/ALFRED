/**
 * The HTTP statuses worth offering in a picker, and the search over them.
 *
 * Its own module rather than a constant inside the component for the usual reason here: the
 * matching is the part with behaviour, and it is worth testing without a fixture. The component
 * only decides when to run it.
 *
 * Not every registered code - a list of 60 is a list nobody reads. These are the ones a supplier
 * integration actually produces, and anything missing is still reachable by typing the number,
 * which is why the custom entry is not a fallback but part of the design: a supplier returning
 * 599 is exactly the case worth reproducing.
 */

export interface HttpStatus {
  readonly code: number;
  readonly phrase: string;
}

export interface StatusGroup {
  readonly label: string;
  readonly statuses: readonly HttpStatus[];
}

export const STATUS_GROUPS: readonly StatusGroup[] = [
  {
    label: '2xx — it worked',
    statuses: [
      { code: 200, phrase: 'OK' },
      { code: 201, phrase: 'Created' },
      { code: 202, phrase: 'Accepted' },
      { code: 204, phrase: 'No Content' },
    ],
  },
  {
    label: '3xx — redirect',
    statuses: [
      { code: 301, phrase: 'Moved Permanently' },
      { code: 302, phrase: 'Found' },
      { code: 304, phrase: 'Not Modified' },
      { code: 307, phrase: 'Temporary Redirect' },
    ],
  },
  {
    label: '4xx — the caller',
    statuses: [
      { code: 400, phrase: 'Bad Request' },
      { code: 401, phrase: 'Unauthorized' },
      { code: 403, phrase: 'Forbidden' },
      { code: 404, phrase: 'Not Found' },
      { code: 405, phrase: 'Method Not Allowed' },
      { code: 408, phrase: 'Request Timeout' },
      { code: 409, phrase: 'Conflict' },
      { code: 422, phrase: 'Unprocessable Entity' },
      { code: 429, phrase: 'Too Many Requests' },
    ],
  },
  {
    label: '5xx — the supplier',
    statuses: [
      { code: 500, phrase: 'Internal Server Error' },
      { code: 501, phrase: 'Not Implemented' },
      { code: 502, phrase: 'Bad Gateway' },
      { code: 503, phrase: 'Service Unavailable' },
      { code: 504, phrase: 'Gateway Timeout' },
      { code: 507, phrase: 'Insufficient Storage' },
    ],
  },
];

const BY_CODE = new Map<number, string>(
  STATUS_GROUPS.flatMap((group) => group.statuses.map((s) => [s.code, s.phrase] as const))
);

/** "503 Service Unavailable", or just the number for one that is not in the list. */
export function statusLabel(code: number | null | undefined): string {
  if (code == null) return '';
  const phrase = BY_CODE.get(code);
  return phrase ? `${code} ${phrase}` : String(code);
}

export function isKnownStatus(code: number | null | undefined): boolean {
  return code != null && BY_CODE.has(code);
}

/** A status code the wire accepts. Deliberately the full range, not just the listed ones. */
export function isValidStatus(code: number | null | undefined): boolean {
  return code != null && Number.isInteger(code) && code >= 100 && code <= 599;
}

/**
 * Filters the groups by a free-text query, matching the code OR the phrase - so "503",
 * "unavail" and "service" all find 503. Empty groups are dropped rather than left as headings
 * with nothing under them.
 */
export function searchStatuses(query: string): readonly StatusGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return STATUS_GROUPS;
  return STATUS_GROUPS.map((group) => ({
    label: group.label,
    statuses: group.statuses.filter(
      (s) => String(s.code).includes(needle) || s.phrase.toLowerCase().includes(needle)
    ),
  })).filter((group) => group.statuses.length > 0);
}

/**
 * The code a free-text query is asking for, when it is asking for one at all.
 *
 * Lets a bare "599" in the search box be offered as a custom code, rather than the user having to
 * find a separate field for it after searching and finding nothing.
 */
export function customStatusFrom(query: string): number | null {
  const trimmed = query.trim();
  if (!/^\d{3}$/.test(trimmed)) return null;
  const code = Number(trimmed);
  return isValidStatus(code) && !isKnownStatus(code) ? code : null;
}
