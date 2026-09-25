import { ResendDraft } from './resend-draft';

/** How a group sends its own calls. Sequential is the default and the only mode a loose call has. */
export type GroupMode = 'sequential' | 'parallel';

export interface ResendGroup {
  readonly id: string;
  readonly name: string;
  readonly mode: GroupMode;
}

/**
 * One thing that can be picked up and moved: a whole group, or a single loose call. This is the
 * unit the list drags and whose arrows reorder - a group is atomic because a group that could be
 * split by dragging would not be a group, while a loose call moves alone exactly as it always did.
 *
 * `runsOf` is the only thing that decides what a group is: a maximal stretch of consecutive
 * drafts sharing a groupId. So "a group is always contiguous" is an invariant of the data rather
 * than a rule any caller has to remember, and a groupId with no matching group degrades to a
 * loose call instead of rendering a nameless header.
 *
 * Note this is NOT the unit of batching - a group is one run, but all the loose calls in a resend
 * still share a single batch, so grouping nothing sends exactly as it did before groups existed.
 */
export interface SendRun {
  readonly kind: 'loose' | 'group';
  /** Null for a loose run. */
  readonly group: ResendGroup | null;
  readonly drafts: readonly ResendDraft[];
  /** Stable across reorders, for @for tracking. */
  readonly trackKey: string;
}

/** Where a run sits in the list, by groupId alone - no group map needed, so reordering works even
 *  if a group is missing. */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly groupId: string | null;
}

function segmentsOf(drafts: readonly ResendDraft[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const groupId = drafts[i].groupId;
    const last = segments[segments.length - 1];
    // Consecutive members of the same group merge; a loose call is always a run of its own, so it
    // can be dragged and arrowed by itself.
    if (groupId !== null && last && last.end === i && last.groupId === groupId) {
      segments[segments.length - 1] = { ...last, end: i + 1 };
    } else {
      segments.push({ start: i, end: i + 1, groupId });
    }
  }
  return segments;
}

/** The list as units of sending, in order. A groupId with no matching group falls back to loose,
 *  so a stale reference degrades to a plain call rather than rendering a nameless header. */
export function runsOf(drafts: readonly ResendDraft[], groups: Readonly<Record<string, ResendGroup>>): SendRun[] {
  return segmentsOf(drafts).map((segment) => {
    const group = segment.groupId === null ? null : groups[segment.groupId] ?? null;
    return {
      kind: group ? ('group' as const) : ('loose' as const),
      group,
      drafts: drafts.slice(segment.start, segment.end),
      trackKey: group ? `g:${group.id}` : `d:${drafts[segment.start].key}`,
    };
  });
}

/** The group's own calls, in list order. */
export function draftsInGroup(drafts: readonly ResendDraft[], groupId: string): ResendDraft[] {
  return drafts.filter((d) => d.groupId === groupId);
}

let nextGroupId = 0;

export function newGroupId(): string {
  return `g${++nextGroupId}`;
}

/** "Group 1", "Group 2", ... - skips a name already taken, so renaming never collides with a default. */
export function nextGroupName(groups: Readonly<Record<string, ResendGroup>>): string {
  const taken = new Set(Object.values(groups).map((g) => g.name));
  for (let n = 1; ; n++) {
    const name = `Group ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Pulls `members` together into one contiguous block at the position of the earliest of them,
 * keeping their existing relative order - so grouping the calls at 1, 4 and 7 makes them 1, 2, 3
 * and shifts everything between up to fill the gaps. Members are passed as drafts rather than keys
 * because that is what every caller already has; a member left in another group moves out of it, so
 * call `pruneGroups` afterwards - that group may now be too small to exist.
 */
export function groupDrafts(
  drafts: readonly ResendDraft[],
  members: readonly ResendDraft[],
  groupId: string
): ResendDraft[] {
  const wanted = new Set(members.map((m) => m.key));
  const inList = drafts.filter((d) => wanted.has(d.key));
  if (inList.length < 2) return [...drafts];
  // Everything before the first member is, by definition, not a member - so the block's landing
  // index in the remaining list is exactly where the first member already was.
  const at = drafts.findIndex((d) => wanted.has(d.key));
  const rest = drafts.filter((d) => !wanted.has(d.key));
  rest.splice(at, 0, ...inList.map((d) => ({ ...d, groupId })));
  return rest;
}

/** Adds loose calls to a group, landing just after its last member so the run stays contiguous. */
export function addToGroup(drafts: readonly ResendDraft[], groupId: string, members: readonly ResendDraft[]): ResendDraft[] {
  const wanted = new Set(members.map((m) => m.key));
  const inList = drafts.filter((d) => wanted.has(d.key));
  if (inList.length === 0) return [...drafts];
  const rest = drafts.filter((d) => !wanted.has(d.key));
  let at = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].groupId === groupId) {
      at = i + 1;
      break;
    }
  }
  rest.splice(at < 0 ? rest.length : at, 0, ...inList.map((d) => ({ ...d, groupId })));
  return rest;
}

/** Dissolves a group. Its calls stay exactly where they are and become loose again. */
export function ungroup(drafts: readonly ResendDraft[], groupId: string): ResendDraft[] {
  return drafts.map((d) => (d.groupId === groupId ? { ...d, groupId: null } : d));
}

/**
 * Puts a loose call into a group at `index` within that group's members. Falls back to appending
 * if the group is not in the list, so a drag racing a removal cannot lose the call.
 *
 * This one INSERTS rather than swapping, because it is an addition and not a move: the group grows
 * by one, so the members from `index` down do shift along. Dropping a call onto a member is the
 * one gesture in the list that is not a straight swap, and it is an addition by nature.
 */
export function addMemberAt(
  drafts: readonly ResendDraft[],
  groupId: string,
  member: ResendDraft,
  index: number
): ResendDraft[] {
  const without = drafts.filter((d) => d.key !== member.key);
  const segment = segmentsOf(without).find((s) => s.groupId === groupId);
  if (!segment) return addToGroup(drafts, groupId, [member]);
  const at = Math.min(Math.max(index, 0), segment.end - segment.start);
  without.splice(segment.start + at, 0, { ...member, groupId });
  return without;
}

/**
 * Takes a call out of whichever group it is in and leaves it loose just before the run at
 * `runIndex` - the run the pointer was let go over. The members left behind stay contiguous, and
 * if that leaves fewer than two of them the caller prunes the group away.
 */
export function extractToRun(drafts: readonly ResendDraft[], member: ResendDraft, runIndex: number): ResendDraft[] {
  const without = drafts.filter((d) => d.key !== member.key);
  const loose = { ...member, groupId: null };
  const target = segmentsOf(without)[runIndex];
  without.splice(target ? target.start : without.length, 0, loose);
  return without;
}

/**
 * Puts the run at `from` where the run at `to` is, so a drag or an arrow means "these changed
 * places" rather than "this was inserted over there".
 *
 * Two runs of the SAME length are a pure exchange: only those two move, and nothing between them
 * shifts. That is the case that matters - a call dragged onto another call - and it is the point.
 * Splicing the dragged call out and back in instead would land it in the right place but shove
 * every call in between along by one, so a call dragged from the top to the bottom would appear to
 * shuffle the whole list: three calls move when the user asked for two.
 *
 * Two runs of DIFFERENT lengths cannot be exchanged at all - a three-call group and a single call
 * do not fit in each other's places - so the moved run lands at the target's position and the
 * target slides along to where the moved run was. For ADJACENT runs that is the same answer as a
 * swap, so this only differs when a group is dragged a longer way, where there is no alternative.
 */
export function swapRuns(drafts: readonly ResendDraft[], from: number, to: number): ResendDraft[] {
  const segments = segmentsOf(drafts);
  if (from === to || from < 0 || from >= segments.length || to < 0 || to >= segments.length) return [...drafts];
  const first = segments[from];
  const second = segments[to];
  const a = drafts.slice(first.start, first.end);
  const b = drafts.slice(second.start, second.end);

  if (a.length === b.length) {
    // Pure exchange. Both writes are into the ORIGINAL indexes, so the second one lands correctly
    // whatever the order - and whatever is between the two runs is never touched.
    const out = [...drafts];
    out.splice(first.start, a.length, ...b);
    out.splice(second.start, b.length, ...a);
    return out;
  }

  const out = drafts.filter((_, i) => i < first.start || i >= first.end);
  // Where the two blocks now change places. Going down, the moved run lands just PAST the target,
  // whose end has been pulled back by the length that was removed. Going up, the target has not
  // moved, so the moved run lands just BEFORE it. Landing on the target's own start instead would
  // put the moved run straight back where it began.
  const at = first.start < second.start ? second.end - (first.end - first.start) : second.start;
  out.splice(at, 0, ...a);
  return out;
}

/** Exchanges two members of one group - the same swap, scoped to the group's own run. */
export function swapMembers(drafts: readonly ResendDraft[], groupId: string, from: number, to: number): ResendDraft[] {
  const segment = segmentsOf(drafts).find((s) => s.groupId === groupId);
  if (!segment) return [...drafts];
  const size = segment.end - segment.start;
  if (from === to || from < 0 || from >= size || to < 0 || to >= size) return [...drafts];
  const out = [...drafts];
  const a = segment.start + from;
  const b = segment.start + to;
  const moved = out[a];
  out[a] = out[b];
  out[b] = moved;
  return out;
}

/** The run `delta` places from `from`, or null when that would be off either end. */
export function runAtOffset(from: number, delta: number, runCount: number): number | null {
  const to = from + delta;
  return to < 0 || to >= runCount ? null : to;
}

/**
 * Drops groups left with fewer than two calls, and clears the id on any draft still pointing at
 * one - a group of one is not a group, and a dangling id would otherwise read as a nameless run.
 */
export function pruneGroups(
  drafts: readonly ResendDraft[],
  groups: Readonly<Record<string, ResendGroup>>
): { drafts: ResendDraft[]; groups: Record<string, ResendGroup> } {
  const sizes = new Map<string, number>();
  for (const d of drafts) {
    if (d.groupId) sizes.set(d.groupId, (sizes.get(d.groupId) ?? 0) + 1);
  }
  const kept: Record<string, ResendGroup> = {};
  for (const [id, group] of Object.entries(groups)) {
    if ((sizes.get(id) ?? 0) >= 2) kept[id] = group;
  }
  return {
    drafts: drafts.map((d) => (d.groupId && !kept[d.groupId] ? { ...d, groupId: null } : d)),
    groups: kept,
  };
}
