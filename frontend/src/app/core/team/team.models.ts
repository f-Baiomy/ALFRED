/**
 * The Team tab's data (specs/028 contracts/teamboards-rest.md). Work items are read live and never stored; Alfred keeps
 * only the filter lists, and for a board its main item and card items in full. Neutral terms: each connector says its
 * own words.
 */
export type Capability = 'BOARDS' | 'SPRINTS' | 'SQUADS' | 'REVISIONS' | 'ATTACHMENTS' | 'CUSTOM_TYPES' | 'SEED' | 'SEARCH' | 'QUERY' | 'TREE'
  | 'WRITE' | 'ATTACH' | 'HOOK' | 'IDENTITY' | 'STATES';

export interface ConnectorInfo {
  readonly kind: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly capabilities: readonly Capability[];
  readonly words: Readonly<Record<'sprint' | 'squad' | 'area' | 'item', string>>;
}

export interface TeamScope {
  readonly projects: readonly string[];
  readonly teams: readonly string[];
}

export interface TeamConnection {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly scope: TeamScope;
  /** When the filter lists were last read. */
  readonly listsAt: string | null;
  readonly createdAt: string;
  readonly capabilities: readonly Capability[];
}

/** A member of the tracker's organisation: what a person pill shows. {@code email} is the unique name. */
export interface TeamPerson {
  readonly extId: string | null;
  readonly name: string;
  readonly email: string | null;
}

export interface TokenStatus {
  readonly live: boolean;
  readonly owner: TeamPerson | null;
  readonly expiresAt: string | null;
}

export interface TeamMe {
  readonly person: TeamPerson;
  readonly source: 'TOKEN_OWNER' | 'OVERRIDE';
}

export interface TeamSquad {
  readonly conn: string;
  readonly extId: string;
  readonly name: string;
  readonly project: string | null;
  readonly alfredProject: string | null;
  readonly alfredTeam: string | null;
  readonly members: readonly TeamPerson[];
}

export interface TeamBoard {
  readonly extId: string;
  readonly name: string;
  readonly project: string | null;
  readonly team: string | null;
  readonly columns: readonly string[];
}

export interface TeamSprint {
  readonly extId: string;
  readonly name: string;
  /** "Project\Team". */
  readonly team: string | null;
  readonly starts: string | null;
  readonly ends: string | null;
}

export interface TeamState {
  readonly project: string;
  readonly type: string;
  readonly name: string;
  /** Proposed, InProgress, Resolved, Completed, Removed. */
  readonly category: string;
}

export interface TeamLists {
  readonly types: readonly string[];
  readonly states: readonly TeamState[];
  readonly areas: readonly string[];
  readonly teams: readonly TeamSquad[];
  readonly iterations: readonly TeamSprint[];
  readonly people: readonly TeamPerson[];
  readonly boards: readonly TeamBoard[];
  readonly at: string | null;
  /** Every tag used in the scope (specs/029); absent from an older Alfred. */
  readonly tags?: readonly string[];
}

export type MineSource = 'ASSIGNED' | 'CREATED' | 'CHANGED' | 'MENTIONED' | 'FOLLOWED';
export type SortBy = 'CHANGED' | 'ID' | 'PRIORITY';

/** How a page of matches is shown: alone, under their parents, or with parents and children (specs/029). */
export type ShowMode = 'ITEMS' | 'PARENTS' | 'TREE';

/**
 * The search body: every list optional (values inside one filter are ORed, filters ANDed); openOnly defaults to true.
 * `assigned` may hold "me" and "none" (unassigned), `createdBy` "me", `iterations` "@current".
 */
export interface TeamSearch {
  text?: string | null;
  types?: string[];
  states?: string[];
  openOnly?: boolean;
  areas?: string[];
  /** Areas match only themselves, not their sub-areas. */
  areaExact?: boolean;
  teams?: string[];
  iterations?: string[];
  assigned?: string[];
  createdBy?: string[];
  changedWithinDays?: number | null;
  tags?: string[];
  /** Every tag must be on the item (else any one). */
  tagsAll?: boolean;
  parents?: string[];
  mine?: MineSource[];
  sort?: SortBy;
  page?: number;
  pageSize?: number;
  show?: ShowMode;
  /** 1 (default) or 0 for every level - with show TREE. */
  childDepth?: number;
}

/** A saved search may be older than specs/029: one person as a string, `parent` for `parents`. */
export function normalizeSearch(q: TeamSearch & { assigned?: unknown; createdBy?: unknown; parent?: unknown }): TeamSearch {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
  const { parent, ...rest } = q;
  return { ...rest, assigned: list(q.assigned), createdBy: list(q.createdBy), parents: [...list(q.parents), ...list(parent)] };
}

/** Where a result already sits on Alfred. */
export interface BoardBadge {
  readonly boardId: string;
  readonly name: string | null;
  readonly role: 'MAIN' | 'CARD' | 'REF';
  readonly copyRev: number | null;
  /** Azure moved past the saved copy. */
  readonly changed: boolean;
}

export interface SearchRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string | null;
  readonly stateCategory: string | null;
  readonly assigned: TeamPerson | null;
  readonly iteration: string | null;
  readonly area: string | null;
  readonly changedAt: string | null;
  readonly rev: number;
  readonly url: string | null;
  readonly boards: readonly BoardBadge[];
  readonly cards: readonly string[];
  /** The parent's id, when the tracker gave one. */
  readonly parent?: string | null;
}

export interface SearchResult {
  readonly items: readonly SearchRow[];
  readonly total: number;
  /** false: the tracker has no full-text search, titles were matched instead. */
  readonly fullText: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly show?: ShowMode;
  /** Parents (and children) of this page's matches that did not match themselves - shown for context. */
  readonly context?: readonly SearchRow[];
  /** Context items past the cap, counted but not read. */
  readonly contextLeftOut?: number;
}

export interface TeamItemLink {
  readonly toId: string;
  readonly kind: string;
}

export interface TeamItem {
  readonly extId: string;
  readonly type: string;
  readonly customType: boolean;
  readonly title: string;
  readonly state: string | null;
  readonly assignee: string | null;
  readonly squad: string | null;
  readonly sprint: string | null;
  readonly area: string | null;
  readonly url: string | null;
  readonly rev: number;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly links: readonly TeamItemLink[];
  readonly identities: Readonly<Partial<Record<string, TeamPerson>>>;
  readonly project: string | null;
}

export interface TeamComment {
  readonly id: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly text: string;
}

export interface TeamRevision {
  readonly rev: number;
  readonly by: string | null;
  readonly at: string | null;
  readonly changes: readonly { readonly field: string; readonly from: string | null; readonly to: string | null }[];
}

export interface TeamAttachment {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly url: string | null;
}

export interface FieldDiff {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface CardLinkRow {
  readonly cardId: string;
  readonly boardId: string | null;
  readonly conn: string;
  readonly item: string;
  readonly linkedAt: string | null;
  readonly linkedBy: string | null;
  readonly hyperlink: boolean;
  readonly tag: boolean;
  readonly commentId: string | null;
}

/** One item read live, with what Alfred keeps of it. */
export interface TeamItemView {
  readonly item: TeamItem;
  readonly stateCategory: string | null;
  readonly comments: readonly TeamComment[] | null;
  readonly history: readonly TeamRevision[] | null;
  readonly attachments: readonly TeamAttachment[] | null;
  readonly copyRev: number | null;
  readonly copySavedAt: string | null;
  readonly diff: readonly FieldDiff[] | null;
  readonly boards: readonly BoardBadge[];
  readonly cards: readonly CardLinkRow[];
}

// ------------------------------------------------------------------------------------------------------ board items

export interface BoardItemRow {
  readonly boardId: string;
  readonly conn: string;
  readonly item: string;
  readonly role: 'MAIN' | 'CARD' | 'REF';
  /** ROOT, ANCESTOR, DESCENDANT, LINK, ADDED. */
  readonly relation: string;
  readonly linkKind: string | null;
  readonly parent: string | null;
  readonly depth: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly state: string | null;
  readonly stateCategory: string | null;
  readonly rev: number;
  readonly leftTreeAt: string | null;
  readonly addedAt: string | null;
  readonly addedBy: string | null;
}

export interface BoardItem {
  readonly row: BoardItemRow;
  readonly hasCopy: boolean;
  readonly copyRev: number | null;
  readonly changed: boolean;
  readonly cards: readonly string[];
}

export interface BoardItemsView {
  readonly boardId: string;
  readonly main: BoardItem | null;
  readonly items: readonly BoardItem[];
  readonly syncedAt: string | null;
  readonly live: boolean;
}

export interface SyncRow {
  readonly id: number;
  readonly conn: string;
  readonly item: string;
  readonly fromRev: number;
  readonly toRev: number;
  readonly at: string;
  readonly diff: readonly FieldDiff[];
  readonly kept: boolean;
}

/** A board's main for the Task tab chip (027's linked item). */
export interface MainSummary {
  readonly conn: string;
  readonly item: string;
  readonly provider: string;
  readonly snapshot: Readonly<Record<string, string>>;
  readonly changes: readonly FieldDiff[];
}

// ------------------------------------------------------------------------------------------------------------ cards

export interface CardItem {
  readonly conn: string;
  readonly item: string;
  readonly type: string | null;
  readonly title: string;
  readonly state: string | null;
  readonly stateCategory: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string | null;
  readonly copyRev: number;
  readonly changed: boolean;
  readonly closedInAzure: boolean;
  readonly comments: readonly TeamComment[];
  readonly url: string | null;
}

export interface Markers {
  hyperlink?: boolean;
  comment?: boolean;
  tag?: boolean;
}

// ------------------------------------------------------------------------------------------------- incoming, rules

export interface IncomingRow {
  readonly boardId: string;
  readonly conn: string;
  readonly item: string;
  readonly source: 'TREE' | 'RULE' | 'HOOK' | 'HAND' | 'MCP';
  readonly arrivedAt: string;
  readonly rev: number;
  readonly type: string | null;
  readonly title: string | null;
  readonly matchCard: string | null;
  readonly matchScore: number | null;
  readonly proposalAction: 'NEW' | 'LINK' | null;
  readonly proposalCard: string | null;
  readonly proposalReason: string | null;
  readonly state: 'WAITING' | 'CARDED' | 'LINKED' | 'IGNORED';
  readonly ignoredRev: number | null;
}

export interface WatchRule {
  readonly id: number;
  readonly boardId: string;
  readonly conn: string;
  readonly name: string;
  readonly queryJson: string;
  readonly createdAt: string;
  readonly lastRunAt: string | null;
  readonly lastSource: string | null;
  readonly lastNew: number;
}

// --------------------------------------------------------------------------------------------------- write bundles

export type StepKind = 'STATE' | 'COMMENT' | 'ATTACH' | 'HYPERLINK' | 'UNHYPERLINK' | 'TAG' | 'UNTAG' | 'CREATE' | 'LINK_ALFRED';
export type WriteState = 'WAITING' | 'SENDING' | 'DONE' | 'PARTIAL' | 'REJECTED';

export interface WriteStep {
  kind: StepKind;
  payload: Record<string, string>;
  ticked: boolean;
  unmasked: boolean;
  result?: { ok: boolean; message: string | null; azureId: string | null } | null;
}

export interface WriteBundle {
  readonly id: number;
  readonly boardId: string | null;
  readonly cardId: string | null;
  readonly conn: string;
  readonly item: string | null;
  /** USER, CLAUDE, or ALFRED (prepared on Verified / Done). */
  readonly origin: string;
  readonly askedIn: string | null;
  readonly title: string;
  readonly steps: readonly WriteStep[];
  readonly state: WriteState;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
}

export interface HookInfo {
  readonly conn: string;
  readonly path: string;
  readonly lastPingAt: string | null;
  readonly lastEvent: string | null;
  readonly badPings: number;
  readonly waiting: readonly string[];
  readonly publicAddress: string | null;
  readonly secretSet: boolean;
}

export interface TypeKind {
  readonly conn: string;
  readonly type: string;
  readonly kind: 'BUG' | 'TASK' | 'QUESTION' | 'NOTE' | 'NONE';
}

// ------------------------------------------------------------------------------------------------------- people

export interface CardInfo {
  readonly id: string;
  readonly boardId: string;
  readonly project: string;
  readonly number: number;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
}

export interface PersonCard {
  readonly person: TeamPerson;
  readonly me: boolean;
  readonly teams: readonly { id: string; name: string; project: string | null }[];
  readonly assignedOpen: number | null;
  readonly cardsOwned: readonly CardInfo[];
  readonly cardsMentioning: readonly CardInfo[];
  readonly boards: readonly string[];
}

export interface MineView {
  readonly me: TeamMe;
  readonly sources: readonly { source: string; count: number; items: readonly SearchRow[]; cards: readonly CardInfo[]; boards: readonly string[] }[];
  readonly failed: Readonly<Record<string, string>>;
}

// ----------------------------------------------------------------------------------------------- mappings, start

export type SeedTarget = 'PURPOSE' | 'STEPS' | 'ACCEPTANCE' | 'CONTEXT';
export type MappingKind = 'SPRINT' | 'SQUAD' | 'AREA' | 'PROJECT';

export interface TeamMapping {
  readonly id: number;
  readonly conn: string;
  readonly kind: MappingKind;
  readonly extValue: string;
  readonly alfredProject: string;
  readonly alfredBoard: string | null;
}

export interface TeamFieldMap {
  readonly conn: string;
  readonly itemType: string;
  readonly field: string;
  readonly target: SeedTarget;
}

/** /ws/teamboards: {conn, board?, what: token|lists|connections|mappings|sync|items|cards|incoming|write|hook|rules|start|me}. */
export interface TeamSocketEvent {
  readonly type: 'team-changed';
  readonly conn: string | null;
  readonly board?: string;
  readonly what: string;
  readonly [extra: string]: unknown;
}

export interface StartTarget {
  readonly project: string;
  readonly boardId: string | null;
  readonly remember: boolean;
}

export interface StartAnswer {
  readonly state: 'WAITING' | 'NEEDS_TARGET' | 'ALREADY_STARTED';
  readonly project: string | null;
  readonly boardId: string | null;
  readonly messageId: number | null;
  readonly attachmentsFetched: number;
  readonly answeredBy?: string | null;
  readonly message: string | null;
}

/** A start waiting for /alfred-setup: where it was posted. */
export interface StartWaiting {
  readonly project: string | null;
  readonly boardId: string | null;
  readonly messageId: number | null;
  readonly at: string | null;
}

/** "Open in Alfred" for a person mention: `@[person:<conn>/<id>|Name]`. */
export function personRef(conn: string, p: TeamPerson): string {
  return `@[person:${conn}/${p.extId ?? p.email ?? p.name}|${(p.name || '').replace(/[\]|]/g, ' ')}]`;
}

/** Whether a category is closed (Completed or Removed). */
export function closedCategory(category: string | null | undefined): boolean {
  return category === 'Completed' || category === 'Removed';
}
