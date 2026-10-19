import { BoardSessionRow, CommandKind, HelperCommand, Holder } from '../../core/models/sessions.models';

/**
 * The board's one Claude control (specs/032 D4): which of its modes it is in, and its words. The Claude button and the
 * Next card both read it, so they never disagree about whether Claude is on.
 */
export type ClaudeMode = 'start' | 'busy' | 'on' | 'paused' | 'failed' | 'held' | 'elsewhere' | 'terminal';

export interface ClaudeView {
  readonly mode: ClaudeMode;
  readonly label: string;
  /** The button's tooltip: what a starting session is doing now, or who holds the board. */
  readonly tooltip: string;
  readonly session: BoardSessionRow | null;
  /** The command in flight (busy) or the start that failed (failed). */
  readonly command: HelperCommand | null;
}

/** Commands that change whether Claude answers the board - while one is in flight the control is busy. */
export const BUSY_KINDS: readonly CommandKind[] = ['START', 'RESUME', 'STOP', 'RELEASE', 'CONTINUE_FROM_COPY', 'ATTACH', 'HANDOVER'];
/** Commands that start Claude: the newest of them failing shows "⚠ Claude didn't start". */
export const START_KINDS: readonly CommandKind[] = ['START', 'RESUME', 'CONTINUE_FROM_COPY', 'ATTACH'];

export interface ClaudeInputs {
  readonly held: Holder | null;
  readonly pending: HelperCommand | null;
  readonly session: BoardSessionRow | null;
  /** The session is this user's. */
  readonly mine: boolean;
  /** It runs on another PC (or another Windows user's helper there). */
  readonly elsewhere: boolean;
  /** The newest START-like command of this board, when it FAILED and was not dismissed. */
  readonly failed: HelperCommand | null;
  /** A terminal /alfred-live (or a cycle chat) answers the board, with no helper session of this user. */
  readonly terminalOn: boolean;
  /** The session's PC is not connected: a Pause queued for it waits there, and Claude still counts as on. */
  readonly pcOffline?: boolean;
}

export function busyLabel(c: HelperCommand): string {
  if (c.state === 'QUEUED') return 'Waiting for your PC…';
  switch (c.kind) {
    case 'RESUME': return 'Resuming…';
    case 'STOP': return 'Pausing…';
    case 'RELEASE':
    case 'HANDOVER': return 'Handing back…';
    default: return 'Starting Claude…';
  }
}

/** "f.biomy@tildetech.ae" → "f.biomy": the button has room for a name, the tooltip carries the address. */
export function shortUser(user: string): string {
  return user.split('@')[0] || user;
}

export function claudeView(i: ClaudeInputs): ClaudeView {
  const s = i.session;
  const base = { session: s, command: null as HelperCommand | null };
  if (i.held) {
    return { ...base, mode: 'held', label: `🔒 ${shortUser(i.held.user)}'s Claude`,
      tooltip: `${i.held.user} holds this board${i.held.machine ? ` (on ${i.held.machine})` : ''} - ask them to hand it over` };
  }
  const parked = i.pending?.kind === 'STOP' && i.pending.state === 'QUEUED' && i.pcOffline;
  if (i.pending && BUSY_KINDS.includes(i.pending.kind) && !parked) {
    return { ...base, command: i.pending, mode: 'busy', label: busyLabel(i.pending), tooltip: s?.progress || busyLabel(i.pending) };
  }
  if (s && i.mine && s.state === 'STARTING') {
    return { ...base, mode: 'busy', label: 'Starting Claude…', tooltip: s.progress || 'Starting Claude…' };
  }
  if (i.failed && !(s && i.mine && s.state === 'ANSWERING' && Date.parse(s.lastActive) > Date.parse(i.failed.updatedAt))) {
    return { ...base, command: i.failed, mode: 'failed', label: "⚠ Claude didn't start", tooltip: 'Click for why and to try again' };
  }
  if (!s || !i.mine) {
    return i.terminalOn
      ? { ...base, mode: 'terminal', label: '● Claude on · terminal', tooltip: 'A terminal /alfred-live answers this board' }
      : { ...base, mode: 'start', label: '▶ Start Claude', tooltip: 'Start Claude for this board on your PC' };
  }
  if (i.elsewhere) return { ...base, mode: 'elsewhere', label: `Claude on ${s.machine}`, tooltip: `Claude for this board runs on ${s.machine}` };
  if (s.state === 'STOPPED' || s.state === 'IDLE') {
    return { ...base, mode: 'paused', label: '▶ Resume Claude', tooltip: 'Claude is paused - Resume continues the same conversation' };
  }
  // The helper reports ANSWERING from its own memory; whether anything still answers is the chat's listener (its runner
  // or a terminal /alfred-live). A runner that died (a PC restart, a Desktop restart, a killed node) left the button
  // saying "Claude on" while every message waited (2026-10-19) - Resume starts the runner again.
  if (s.state === 'ANSWERING' && !i.terminalOn) {
    return { ...base, mode: 'paused', label: '▶ Resume Claude',
      tooltip: `Claude stopped answering this board on ${s.machine} - nothing listens to its chat. Resume starts it again` };
  }
  const extra = s.state === 'WAITING_LIMIT' ? ' · usage limit' : s.state === 'WAITING_BUDGET' ? ' · budget reached' : '';
  return { ...base, mode: 'on', label: `● Claude on${extra}`, tooltip: `Claude answers this board on ${s.machine}` };
}
