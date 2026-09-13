import { CallRecord } from '../../core/models/call.model';
import { SortMode } from '../../core/models/call.model';

/**
 * Which of the three call views the list is rendering (see call-list.component.html):
 *
 * - 'flat-depth' (the DEFAULT): today's flat, full-width cards in their normal order, each one
 *   additionally carrying a depth badge naming its parent and a bar showing where it sits inside
 *   its root call's window. Nothing is reordered or nested, so this is the only view that composes
 *   with every sort mode and with group-by-supplier - and the only one that keeps the
 *   request/response split (see splitCallsForDisplay), since nothing else marks where a parent
 *   call ended.
 * - 'nested': child cards render INSIDE their parent's card, so containment is literal. No split -
 *   the card already encloses its children, so request/response halves would only restate it.
 * - 'waterfall': compact one-line rows with a depth rail and a timing bar, expanding to the full
 *   card on click. No split either - the bar's own edges already are the call's start and end.
 *
 * 'nested'/'waterfall' both draw a tree, which only reads correctly when the list is in time order
 * (see CHRONOLOGICAL_SORT_MODES / isTreeSortMode) - selecting one switches a non-chronological sort
 * back to a chronological one rather than drawing a tree over an order that can't support it.
 */
export type CallViewMode = 'flat-depth' | 'nested' | 'waterfall';

export const DEFAULT_CALL_VIEW_MODE: CallViewMode = 'flat-depth';

/** The view modes that can only render a coherent tree in time order - see CallViewMode's doc. */
export function requiresChronologicalSort(mode: CallViewMode): boolean {
  return mode === 'nested' || mode === 'waterfall';
}

/** Mirrors call-utils.ts's CHRONOLOGICAL_SORT_MODES (not imported, to keep this file free of the
 * split/row concerns) - the sort modes in which a parent and its children stay contiguous. */
const TREE_SORT_MODES: ReadonlySet<SortMode> = new Set(['newest', 'oldest', 'newest-call', 'oldest-call']);

export function isTreeSortMode(mode: SortMode): boolean {
  return TREE_SORT_MODES.has(mode);
}

/** The sort a non-chronological one falls back to when a tree view is selected - the dashboard's
 * own default, so the list lands somewhere familiar rather than somewhere arbitrary. */
export const TREE_FALLBACK_SORT_MODE: SortMode = 'newest';

/**
 * One call plus everything proven to have happened inside it. `children` is in chronological order
 * regardless of the list's own sort, since a parent's children only read as a sequence that way.
 */
export interface CallTreeNode {
  readonly call: CallRecord;
  readonly children: readonly CallTreeNode[];
  /** 0 for a root call, 1 for its direct children, and so on. Uncapped - see depthRailPx for how
   * rendering stops indenting past a point without flattening the data itself. */
  readonly depth: number;
}

/**
 * Everything the flat-depth view needs to annotate ONE card without any nesting or reordering:
 * which call it sits inside, how deep, how much is underneath it, and where its own window falls
 * inside its root call's. Computed for every call in the list (see indexCallTree), including roots.
 */
export interface CallDepthInfo {
  readonly depth: number;
  /** Display name of the parent call's own service ('Odeysys', 'Core-service'), or null at a root.
   * Title-cased the same way sourceLabelOf does, so the badge reads like the source badge beside it. */
  readonly parentLabel: string | null;
  readonly parentId: string | null;
  /** Directly nested calls only - `descendantCount` counts the whole subtree. */
  readonly childCount: number;
  readonly descendantCount: number;
  /** 0-1 fractions of the ROOT call's window: where this call starts, and how much of it it spans.
   * Both null when the root has no measurable duration (an in-progress root, or one that resolved
   * instantly), in which case the card renders no bar rather than a misleading full-width one. */
  readonly spanStart: number | null;
  readonly spanWidth: number | null;
  /**
   * The same position as `spanStart`, in milliseconds after the root call began, and the root's own
   * total duration - the two numbers a fraction can't convey on its own. A track only a few hundred
   * pixels wide cannot show that four calls started 80ms apart on a 12-second call; printing "+1.85s"
   * next to each one can, and it also surfaces how long the root spent before calling anything at
   * all. Null under the same no-measurable-root condition as the fractions above.
   */
  readonly offsetMs: number | null;
  readonly rootDurationMs: number | null;
  /** True when this call sits inside more than one call that could equally claim it and none of
   * those contains the others - so it stays at root level, flagged, rather than being guessed into
   * somebody's subtree. Mirrors the ambiguity veto in call-utils.ts's computeSplitCallIds. */
  readonly ambiguous: boolean;
}

function windowOf(call: CallRecord): { start: number; end: number } {
  const start = new Date(call.timestamp).getTime();
  const duration = call.duration_ms ?? 0;
  return { start, end: start + duration };
}

function isResolvedInternal(call: CallRecord): boolean {
  return call.source === 'internal' && call.state !== 'IN_PROGRESS' && (call.duration_ms ?? 0) > 0;
}

/**
 * Can `parent` own `child`? Deliberately the same two questions call-utils.ts's
 * isStrictlyContained/passesOwnershipCheck ask of a candidate, so a tree edge exists exactly where
 * the split algorithm already finds evidence - the two features can never disagree about what's
 * nested inside what.
 *
 * Only a resolved INTERNAL call can be a parent: an external call is an outbound leaf, and nothing
 * Alfred logs ever happens "inside" one. A still-in-progress call has no end yet, so nothing can be
 * shown to fall within it.
 */
function canOwn(parent: CallRecord, child: CallRecord): boolean {
  if (parent.id === child.id) return false;
  if (!isResolvedInternal(parent)) return false;

  const p = windowOf(parent);
  const c = windowOf(child);
  if (!(c.start >= p.start && c.end <= p.end)) return false;

  const parentService = parent.service_name ?? null;
  if (child.source === 'internal') return (child.service_name ?? null) !== parentService;
  const childService = child.service_name ?? null;
  if (childService == null) return true;
  return childService === parentService;
}

/** Title-cases a service name for display the same way sourceLabelOf does ('odeysys' -> 'Odeysys'). */
function serviceLabel(call: CallRecord): string {
  const name = call.service_name ?? '';
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Internal';
}

interface Parented {
  readonly parent: CallRecord | null;
  readonly ambiguous: boolean;
}

/**
 * Picks the ONE call a given call is nested in, out of everything that could own it.
 *
 * The innermost (shortest) owner wins, but only once the owners are confirmed to form a single
 * nested chain: odeysys containing core-service containing this call is not ambiguous at all, it
 * just means core-service is the real parent. Genuine ambiguity is two owners that merely OVERLAP -
 * neither inside the other - both containing this call, where there's no way to tell whose work it
 * was. That case takes no parent and is flagged, exactly as computeSplitCallIds's veto drops a
 * candidate two calls could equally claim rather than guessing for either.
 */
function resolveParent(call: CallRecord, calls: readonly CallRecord[]): Parented {
  const owners = calls.filter((candidate) => canOwn(candidate, call));
  if (owners.length === 0) return { parent: null, ambiguous: false };

  const innermost = owners.reduce((best, candidate) =>
    (candidate.duration_ms ?? 0) < (best.duration_ms ?? 0) ? candidate : best
  );
  // canOwn in BOTH directions means identical windows, which is ambiguity rather than nesting - so
  // a chain requires the containment to be one-directional.
  const chained = owners.every(
    (owner) => owner.id === innermost.id || (canOwn(owner, innermost) && !canOwn(innermost, owner))
  );
  return chained ? { parent: innermost, ambiguous: false } : { parent: null, ambiguous: true };
}

function startOf(node: CallTreeNode): number {
  return new Date(node.call.timestamp).getTime();
}

/**
 * Builds the forest for `calls` - every call appears exactly once, either as a root or nested under
 * the single call proven to contain it (see resolveParent). Roots keep the order `calls` arrived in,
 * so the list's own sort mode still decides what the user sees first; children are always sorted
 * chronologically, since a parent's own downstream work only reads as a sequence in time order.
 */
export function buildCallTree(calls: readonly CallRecord[]): readonly CallTreeNode[] {
  const parentIdByCallId = new Map<string, string | null>();
  for (const call of calls) {
    parentIdByCallId.set(call.id, resolveParent(call, calls).parent?.id ?? null);
  }

  const childrenByParentId = new Map<string, CallRecord[]>();
  const roots: CallRecord[] = [];
  for (const call of calls) {
    const parentId = parentIdByCallId.get(call.id) ?? null;
    if (parentId == null) {
      roots.push(call);
      continue;
    }
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(call);
    childrenByParentId.set(parentId, siblings);
  }

  const build = (call: CallRecord, depth: number): CallTreeNode => ({
    call,
    depth,
    children: (childrenByParentId.get(call.id) ?? [])
      .map((child) => build(child, depth + 1))
      .sort((a, b) => startOf(a) - startOf(b)),
  });

  return roots.map((root) => build(root, 0));
}

/**
 * Every call nested under each call in `tree`, at ANY depth, keyed by the containing call's id -
 * what "select this call and everything it caused" needs, and what a parent's tri-state checkbox
 * counts over. Every call gets an entry, leaves included (an empty array), so a caller never has to
 * distinguish "no descendants" from "not in this tree".
 *
 * Returns CallRecords rather than ids because selection is keyed by `callKey()` (a content hash),
 * not by `call.id` - see call-utils.ts.
 */
export function indexDescendants(tree: readonly CallTreeNode[]): ReadonlyMap<string, readonly CallRecord[]> {
  const index = new Map<string, readonly CallRecord[]>();

  const collect = (node: CallTreeNode): CallRecord[] => {
    const below = node.children.flatMap((child) => [child.call, ...collect(child)]);
    index.set(node.call.id, below);
    return below;
  };

  for (const root of tree) collect(root);
  return index;
}

/**
 * The ids of every call in `tree` that has children - the calls a fold control appears on, and the
 * complete set "collapse all" collapses. A call with no children has nothing to fold, so putting it
 * in the collapsed set would be a no-op that "expand all" then has to clean up.
 */
export function foldableIds(tree: readonly CallTreeNode[]): readonly string[] {
  const ids: string[] = [];
  const walk = (node: CallTreeNode): void => {
    if (node.children.length > 0) ids.push(node.call.id);
    node.children.forEach(walk);
  };
  tree.forEach(walk);
  return ids;
}

/**
 * Flattens the forest into per-call annotations for the flat-depth view, which renders no hierarchy
 * of its own and so needs every fact stated on the card itself. Keyed by call id.
 */
export function indexCallTree(calls: readonly CallRecord[]): ReadonlyMap<string, CallDepthInfo> {
  const index = new Map<string, CallDepthInfo>();
  const tree = buildCallTree(calls);

  const ambiguousIds = new Set<string>();
  for (const call of calls) {
    if (resolveParent(call, calls).ambiguous) ambiguousIds.add(call.id);
  }

  const countDescendants = (node: CallTreeNode): number =>
    node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);

  const walk = (node: CallTreeNode, root: CallTreeNode, parent: CallTreeNode | null): void => {
    const rootWindow = windowOf(root.call);
    const rootDuration = rootWindow.end - rootWindow.start;
    const own = windowOf(node.call);
    const measurable = rootDuration > 0;

    index.set(node.call.id, {
      depth: node.depth,
      parentLabel: parent ? serviceLabel(parent.call) : null,
      parentId: parent?.call.id ?? null,
      childCount: node.children.length,
      descendantCount: countDescendants(node),
      spanStart: measurable ? clamp01((own.start - rootWindow.start) / rootDuration) : null,
      spanWidth: measurable ? clamp01((own.end - own.start) / rootDuration) : null,
      offsetMs: measurable ? Math.max(0, own.start - rootWindow.start) : null,
      rootDurationMs: measurable ? rootDuration : null,
      ambiguous: ambiguousIds.has(node.call.id),
    });

    for (const child of node.children) walk(child, root, node);
  };

  for (const root of tree) walk(root, root, null);
  return index;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** How far one depth level indents, and the level past which indenting stops. Nesting itself is
 * uncapped (see CallTreeNode.depth) - a very deep chain keeps building correctly, it just stops
 * eating horizontal room once the rail has made the point. */
const INDENT_PER_LEVEL_PX = 14;
const MAX_INDENT_LEVELS = 3;

export function depthRailPx(depth: number): number {
  return Math.min(depth, MAX_INDENT_LEVELS) * INDENT_PER_LEVEL_PX;
}

/** How many hues the depth ramp cycles through before repeating - see depthTintClass. */
const DEPTH_TINTS = 4;

/**
 * The class carrying this depth's rail colour (`depth-tint-0` .. `depth-tint-3`, cycling), defined
 * in styles.scss as a `--depth-color` custom property.
 *
 * Depth used to be conveyed by indent alone, and `depthRailPx` caps indenting at MAX_INDENT_LEVELS -
 * so past that point two different levels were drawn identically. Colour keeps working where the
 * indent has stopped, and it makes a chain of callers (a parent whose child is itself a parent)
 * readable at a glance rather than by counting pixels.
 *
 * Cycling rather than running out: a hue repeats every 4 levels, by which point the two levels
 * sharing it are far enough apart vertically to not be confusable.
 */
export function depthTintClass(depth: number): string {
  return `depth-tint-${((depth % DEPTH_TINTS) + DEPTH_TINTS) % DEPTH_TINTS}`;
}

/** One vertical guide line on a waterfall row - see depthRails. */
export interface DepthRail {
  readonly tint: string;
  /** How far the NEXT line sits from this one; 0 on the last, which is only a line. */
  readonly widthPx: number;
  /** The last rail: this row's own level. Ancestor guides are drawn dimmer than it. */
  readonly own: boolean;
}

/**
 * The full stack of guide lines for a row at `depth`: one per ancestor level, then the row's own.
 *
 * A single line at the row's own indent (which is all this used to draw) says how far in a call sits
 * but nothing about what it sits inside - so a depth-2 row was one short tick floating in space, and
 * the level colours it was supposed to carry had nothing beside them to be read against. Drawing the
 * ancestors too makes the nesting a continuous line down the page, which is what a tree view is for.
 *
 * Widths come from depthRailPx so the total indent is unchanged: the lines are added inside the
 * space that was already being reserved, not on top of it.
 */
export function depthRails(depth: number): readonly DepthRail[] {
  const levels = Math.min(Math.max(depth, 0), MAX_INDENT_LEVELS);
  const rails: DepthRail[] = [];
  for (let level = 0; level < levels; level++) {
    rails.push({ tint: depthTintClass(level), widthPx: INDENT_PER_LEVEL_PX, own: false });
  }
  // Past MAX_INDENT_LEVELS the ancestors stop getting their own lines (there is no room), but the
  // row's own level still colours the last one - otherwise depth 4 would be drawn as depth 3.
  rails.push({ tint: depthTintClass(depth), widthPx: 0, own: true });
  return rails;
}
