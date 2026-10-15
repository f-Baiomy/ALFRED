import { MentionRef } from '../../core/models/board.models';
import { PROJECT_SCOPE } from '../../core/models/chat.models';

/**
 * What the user is looking at, carried on a chat message as removable chips (specs/022 FR-020, FR-021). The chips are
 * the board's own mentions, so Claude reads them with the tools it already has and the panel draws them with the same
 * chips as a comment.
 */

/** The most chips one message carries (the backend keeps 10). */
export const MAX_CHIPS = 10;

/** The chat an item is asked about in: its cycle's chat when it is in a cycle, else the project's. */
export function chatScopeFor(cycleId: string | null | undefined): string {
  return cycleId ? cycleId : PROJECT_SCOPE;
}

/** The fields of a call a chip needs - a CallRecord or a summary of one. */
export interface CallLike {
  readonly id: string;
  readonly source?: string | null;
  readonly method: string;
  readonly url: string;
  readonly response?: { readonly status?: number | null } | null;
  readonly error?: unknown;
}

/** A call's mention as "Add to board" writes it: `in:<id>@<cycle>` / `out:<id>`, labelled "POST /path · 500". */
export function callChip(call: CallLike, cycleId: string | null): MentionRef {
  const inbound = call.source === 'internal';
  let path = call.url;
  try {
    path = new URL(call.url).pathname;
  } catch {
    // already a path
  }
  const status = call.response?.status ?? (call.error ? 'error' : '…');
  return { type: 'call', ref: `${inbound ? 'in' : 'out'}:${call.id}${cycleId ? `@${cycleId}` : ''}`, label: `${call.method} ${path} · ${status}` };
}

/** A database statement of a call: `<callId>/<seq>`, as the mention picker writes it. */
export function statementChip(callId: string, seq: number, kind: string, table: string | null): MentionRef {
  return { type: 'stmt', ref: `${callId}/${seq}`, label: `${kind} ${table ?? ''} #${seq}`.replace(/\s+/g, ' ').trim() };
}

/** A log line of a call: `<callId>/<lineId>`. */
export function logChip(callId: string, lineId: string | number, level: string | null, logger: string | null): MentionRef {
  return { type: 'log', ref: `${callId}/${lineId}`, label: `${level ?? ''} ${(logger ?? '').split('.').pop()}`.trim() || 'log line' };
}

/** The card open in the drawer: `<project>#<number>`. */
export function cardChip(project: string, number: number, title: string): MentionRef {
  return { type: 'card', ref: `${project}#${number}`, label: title.length > 60 ? `${title.slice(0, 59)}…` : title };
}

/** Adds a chip once (same type and ref), newest last, at most {@link MAX_CHIPS} - the oldest go first. */
export function withChip(chips: readonly MentionRef[], chip: MentionRef): MentionRef[] {
  const key = (c: MentionRef) => `${c.type}:${c.ref}`;
  const out = chips.filter((c) => key(c) !== key(chip));
  out.push(chip);
  return out.slice(-MAX_CHIPS);
}

export function withoutChip(chips: readonly MentionRef[], chip: MentionRef): MentionRef[] {
  return chips.filter((c) => !(c.type === chip.type && c.ref === chip.ref));
}
