/**
 * Logs linked to calls (specs/008-logs-call-link, contracts/call-logs-api.md): a project's application log lines
 * matched to the inbound calls they were written during - exactly (the db-agent's tag) or by request thread and time.
 */

/** EXACT / THREAD_TIME: a log-file line matched to the call (008); CAUGHT: caught by the agent inside the call (009). */
export type LogMatch = 'EXACT' | 'THREAD_TIME' | 'CAUGHT';

/** The exception a caught line carried. */
export interface LogException {
  readonly type: string | null;
  readonly message: string | null;
  readonly stack: string | null;
}

/** Why a call shows no lines: LINKING_OFF = the project's ▤ switch or its logging is off (nothing is read). */
export type CallLogsSetup = 'OK' | 'LINKING_OFF' | 'NO_SOURCE' | 'NO_THREAD';

export interface LinkedLogLine {
  readonly sourceId: string;
  readonly sourceName: string;
  /** `<inputId>:<offset>` - the Logs tab's line identity. */
  readonly lineId: string;
  /** ISO instant of the line's time field. */
  readonly at: string;
  /** Milliseconds from the call's start (negative within the allowed clock difference). */
  readonly offsetMs: number;
  readonly level: string | null;
  readonly thread: string | null;
  readonly logger: string | null;
  readonly message: string;
  readonly matchedBy: LogMatch;
  /** ALFRED's own copy (a session-cycle or imported call) - served even when the log source no longer has it. */
  readonly kept?: boolean;
  /** The whole original line. */
  readonly raw: string;
  /** A caught line's exception (specs/009-agent-log-capture). */
  readonly exception?: LogException | null;
  /** A caught line's place in the call's own order, shared with its statements and supplier calls. */
  readonly seq?: number | null;
}

export interface CallLogsPage {
  readonly callId: string;
  readonly setup: CallLogsSetup;
  readonly matchedBy: LogMatch | null;
  readonly thread: string | null;
  readonly clockSkewMs: number;
  readonly lines: readonly LinkedLogLine[];
  readonly next: string | null;
  /** Lines the agent did not keep for the call (its caps, or late) - 0 for log-file lines. */
  readonly dropped?: number;
}

export interface LogCounts {
  readonly lines: number;
  readonly errors: number;
  readonly warnings: number;
  readonly matchedBy: LogMatch | null;
}

export interface ProjectLogSettings {
  readonly project: string;
  readonly sourceIds: readonly string[];
  readonly threadField: string | null;
  readonly timeField: string | null;
  readonly callIdField: string;
  readonly clockSkewMs: number;
}

export interface ProjectLogsView {
  readonly settings: ProjectLogSettings;
  /** Per linked source, lines carrying the call-id field - whether the agent's tag reaches the log. */
  readonly callIdFoundLines: Readonly<Record<string, number>>;
}

/** The call a Logs-tab line was written during (GET /call-logs/for-line). */
export interface LineCall {
  readonly call: { readonly id: string; readonly method: string; readonly url: string; readonly status: number | null; readonly durationMs: number; readonly service: string | null; readonly at: string };
  readonly matchedBy: LogMatch;
}
