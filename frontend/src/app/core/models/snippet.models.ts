/** Pages, versions, saved state and shots (specs/017) - as /board/pages and /board/snippets/** send them. */
export type SnippetOwnerType = 'CARD' | 'CYCLE' | 'PROJECT';
export type SnippetKind = 'HTML' | 'MERMAID' | 'PYTHON' | 'BLOCK';
export type SnippetActor = 'USER' | 'CLAUDE';

export interface SnippetPage {
  readonly id: string;
  readonly ownerType: SnippetOwnerType;
  readonly ownerId: string;
  readonly project: string;
  readonly cardId: string | null;
  readonly cycleId: string | null;
  readonly name: string;
  readonly kind: SnippetKind;
  /** The fence's settings: `live libs="…" height=…`. */
  readonly info: string;
  /** Null in lists. */
  readonly source: string | null;
  readonly author: SnippetActor;
  readonly pinned: boolean;
  readonly position: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: SnippetActor;
}

export interface SnippetVersionInfo {
  readonly snippetId: string;
  readonly version: number;
  readonly name: string;
  readonly info: string;
  readonly source: string | null;
  readonly size: number;
  readonly author: SnippetActor;
  readonly at: string;
}

export interface SnippetStateValue {
  readonly snippetId: string;
  readonly key: string;
  /** JSON text. */
  readonly value: string;
  readonly updatedBy: SnippetActor;
  readonly at: string;
}

export interface SnippetShotInfo {
  readonly snippetId: string;
  readonly version: number;
  readonly at: string;
  readonly console: string;
  readonly png: string;
}

/** `card:<id>`, `cycle:<id>` or `project:<name>`. */
export type SnippetOwner = `card:${string}` | `cycle:${string}` | `project:${string}`;

export interface NewSnippetPage {
  readonly owner: SnippetOwner;
  readonly project?: string | null;
  readonly name: string;
  readonly kind?: SnippetKind;
  readonly info?: string;
  readonly source: string;
}

export interface SnippetPageEdit {
  readonly name?: string;
  readonly info?: string;
  readonly source?: string;
  readonly pinned?: boolean;
  readonly position?: number;
  /** The version the editor started from: a newer saved one makes the save a conflict (409). */
  readonly baseVersion?: number;
}

/** A file attached to a card or a cycle (specs/017 R36); its bytes are read from /board/files/<id>. */
export interface BoardFileInfo {
  readonly id: string;
  readonly project: string;
  readonly cardId: string | null;
  readonly cycleId: string | null;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly author: 'USER' | 'CLAUDE';
  readonly createdAt: string;
}

/** Where a file goes: a card, or a cycle with its project. */
export type FilePlace = { readonly card: string } | { readonly cycle: string; readonly project: string };

/** A project's widget (specs/017 R34); `source` is absent in lists. */
export interface WidgetInfo {
  readonly project: string;
  readonly name: string;
  readonly kind: 'HTML' | 'MERMAID' | 'PYTHON' | 'BLOCK';
  readonly info: string;
  readonly source?: string | null;
  readonly author: 'USER' | 'CLAUDE';
  readonly updatedAt: string;
  readonly updatedBy: 'USER' | 'CLAUDE';
}

/** The file types a card may hold (the backend's list; anything else is refused there too). */
export const FILE_TYPES = ['csv', 'json', 'txt', 'log', 'har', 'xml', 'sql', 'md', 'pdf', 'png', 'jpg', 'jpeg'] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
