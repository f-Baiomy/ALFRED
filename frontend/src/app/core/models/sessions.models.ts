/** Board sessions, the board lock and My settings (specs/031, docs/board.md "Board sessions"). */

export type SessionState = 'STARTING' | 'ANSWERING' | 'IDLE' | 'WAITING_BUDGET' | 'WAITING_LIMIT' | 'STOPPED' | 'GONE';
export type OpenIn = 'NONE' | 'DESKTOP' | 'TERMINAL';

export interface Me {
  readonly user: string | null;
  readonly machine: string | null;
  readonly kind: 'HELPER' | 'BROWSER' | null;
  readonly keyId: string | null;
  readonly helperKeyId: string | null;
  readonly admin: boolean;
}

export interface HelperInfo {
  readonly version?: string;
  readonly claudeAccount?: string;
  readonly desktop?: boolean;
  readonly mcp?: string | null;
  readonly azureToken?: boolean;
  readonly platform?: string;
  readonly sessions?: readonly { cliSessionId: string; boardId: string }[];
}

export interface HelperRow {
  readonly keyId: string;
  readonly user: string;
  readonly machine: string;
  readonly online: boolean;
  readonly lastSeen: string | null;
  readonly createdAt: string;
  readonly claudeAccount?: string;
  readonly ip?: string;
  /** JSON of {@link HelperInfo}, own helpers only. */
  readonly info?: string;
}

export interface BrowserRow {
  readonly keyId: string;
  readonly label: string;
  readonly pairedAt: string;
  readonly lastSeen: string;
  readonly thisOne: boolean;
}

export interface Devices {
  readonly helpers: readonly HelperRow[];
  readonly browsers: readonly BrowserRow[];
}

export interface HolderRequest {
  readonly user: string;
  readonly machine: string;
  readonly note: string;
  readonly at: string;
}

export interface Holder {
  readonly boardId: string;
  readonly project: string;
  readonly user: string;
  readonly machine: string;
  readonly sessionId: string | null;
  readonly since: string;
  readonly commenters: readonly string[];
  readonly request: HolderRequest | null;
}

export interface BoardSessionRow {
  readonly id: string;
  readonly boardId: string;
  readonly project: string;
  readonly cliSessionId: string;
  readonly desktopId: string | null;
  readonly user: string;
  readonly machine: string;
  readonly helperKeyId: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly state: SessionState;
  readonly openIn: OpenIn;
  readonly lastChatSeq: number;
  readonly tokensToday: number;
  readonly tokensDay: string | null;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastActive: string;
}

export type CommandKind = 'START' | 'RESUME' | 'OPEN_DESKTOP' | 'OPEN_TERMINAL' | 'STOP' | 'STOP_ALL' | 'PICK_FOLDER' | 'BRING_TRANSCRIPT'
  | 'SEND_TRANSCRIPT' | 'SYNC' | 'CONTINUE_FROM_COPY' | 'ATTACH' | 'LISTEN' | 'STOP_LISTEN' | 'HANDOVER' | 'RESTART_DESKTOP';
export type CommandState = 'QUEUED' | 'TAKEN' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface HelperCommand {
  readonly id: string;
  readonly helperKeyId: string;
  readonly user: string;
  readonly kind: CommandKind;
  readonly boardId: string | null;
  readonly project: string;
  readonly sessionId: string | null;
  readonly args: string;
  readonly state: CommandState;
  readonly result: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditLine {
  readonly id: number;
  readonly at: string;
  readonly boardId: string;
  readonly what: string;
  readonly user: string;
  readonly machine: string;
  readonly via: string;
}

export interface UserLine {
  readonly user: string;
  readonly machines: readonly string[];
  readonly browsers: number;
  readonly lastSeen: string | null;
}

/** Where a project's sessions open on one PC (My settings). */
export interface ProjectPlace {
  readonly project: string;
  readonly machine: string;
  readonly folder: string;
  readonly openIn: 'DESKTOP' | 'TERMINAL' | 'BOTH' | 'BACKGROUND';
  readonly worktrees: boolean;
}

/** My settings, as stored for the user - never a token. */
export interface MySettings {
  readonly projects?: readonly ProjectPlace[];
  readonly models?: { readonly chat?: string; readonly setup?: string; readonly fix?: string; readonly default?: string };
  readonly budget?: { readonly dailyTokens?: number };
  readonly maxSessions?: number;
  readonly away?: { readonly hours?: number; readonly action?: 'accept' | 'release' | 'nothing' };
  readonly notify?: { readonly questions?: boolean; readonly drafts?: boolean; readonly findings?: boolean; readonly requests?: boolean };
}

export interface SessionsEvent {
  readonly type: 'sessions-changed';
  readonly what: 'holders' | 'sessions' | 'commands' | 'keys' | 'settings' | 'connect';
  readonly boardId?: string;
}

/** The board a chat scope belongs to: the project chat is the project's default board. */
export function boardOfScope(project: string, scope: string | null | undefined): string {
  return !scope || scope === 'project' ? `default:${project}` : scope;
}

/** A commenter's chat message waiting for the holder's OK (specs/031). */
export interface PendingMessage {
  readonly id: number;
  readonly boardId: string;
  readonly project: string;
  readonly scope: string;
  readonly user: string;
  readonly machine: string;
  readonly text: string;
  readonly at: string;
}

/** POST /board/connect: the file to save (its text carries a one-time token) and how this browser collects its key. */
export interface ConnectStart {
  readonly connectId: string;
  readonly collectSecret: string;
  readonly expiresAt: string;
  readonly fileName: string;
  readonly script: string;
  /** What to tell the user: "Double-click alfred-connect.cmd in your Downloads". */
  readonly run: string;
  readonly versions: { readonly helper: string; readonly skills: string; readonly node: boolean };
}
