/** The Team tab's data (specs/027 contracts/teamboards-rest.md). Neutral terms: each connector says its own words. */
export type Capability = 'BOARDS' | 'SPRINTS' | 'SQUADS' | 'REVISIONS' | 'ATTACHMENTS' | 'CUSTOM_TYPES' | 'SEED';

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
  readonly fetchedAt: string | null;
  readonly fetchedBy: string | null;
  readonly seenAt: string | null;
  readonly createdAt: string;
  readonly capabilities: readonly Capability[];
  readonly newChanges: number;
}

export interface TeamItem {
  readonly conn: string;
  readonly extId: string;
  readonly type: string;
  readonly customType: boolean;
  readonly title: string;
  readonly state: string | null;
  readonly assignee: string | null;
  readonly squad: string | null;
  readonly sprint: string | null;
  readonly area: string | null;
  readonly url: string;
  readonly rev: number;
  readonly changedAt: string | null;
}

export interface TeamItemsPage {
  readonly items: readonly TeamItem[];
  readonly total: number;
}

export type SeedTarget = 'PURPOSE' | 'STEPS' | 'ACCEPTANCE' | 'CONTEXT';

export interface TeamItemField {
  readonly key: string;
  readonly value: string | null;
  readonly mappedTo: SeedTarget | null;
}

export interface TeamItemLink {
  readonly toId: string;
  readonly kind: string;
}

export interface TeamItemDetail {
  readonly item: TeamItem;
  readonly fields: readonly TeamItemField[];
  readonly links: readonly TeamItemLink[];
  /** The Alfred board this item opened, or null. */
  readonly board: string | null;
  readonly startState: string | null;
}

export interface TeamRevision {
  readonly rev: number;
  readonly by: string | null;
  readonly at: string | null;
  readonly changes: readonly { readonly field: string; readonly from: string | null; readonly to: string | null }[];
}

export interface TeamChange {
  readonly id: number;
  readonly conn: string;
  readonly extId: string;
  readonly rev: number;
  readonly by: string | null;
  readonly squad: string | null;
  readonly at: string;
  readonly summary: string;
  readonly title: string | null;
  readonly fresh: boolean;
}

export interface TeamSquad {
  readonly conn: string;
  readonly extId: string;
  readonly name: string;
  readonly project: string | null;
  readonly alfredProject: string | null;
  readonly alfredTeam: string | null;
  readonly members: readonly string[];
}

export interface TeamPerson {
  readonly extId: string;
  readonly name: string;
  readonly email: string | null;
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
  readonly team: string | null;
  readonly starts: string | null;
  readonly ends: string | null;
}

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

export interface TeamItemFilters {
  readonly q?: string;
  readonly type?: string;
  readonly squad?: string;
  readonly state?: string;
  readonly assignee?: string;
  readonly sprint?: string;
}

/** /ws/teamboards: {conn, what: items|changes|connections|squads|mappings|start}. */
export interface TeamSocketEvent {
  readonly type: 'team-changed';
  readonly conn: string | null;
  readonly what: string;
  /** what: refresh - how a background refresh ended (OK, TOKEN_REJECTED, PROVIDER_BUSY, UNREACHABLE...). */
  readonly outcome?: string;
  readonly changed?: number;
  readonly retryAfter?: number | null;
  readonly message?: string | null;
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
  /** Who runs /alfred-setup now; null: nobody is live and `message` says so. */
  readonly answeredBy?: string | null;
  readonly message: string | null;
}

/** An Alfred board's work item (GET /teamboards/links/{board}). */
export interface TeamLink {
  readonly board: string;
  readonly conn: string;
  readonly extId: string;
  readonly provider: string;
  readonly snapshot: Readonly<Record<string, string>>;
  readonly changedSinceSetup: readonly { field: string; from: string | null; to: string | null; by: string | null; at: string | null }[];
  readonly attachments: readonly { name: string; size: number; url: string; held: boolean }[];
}
