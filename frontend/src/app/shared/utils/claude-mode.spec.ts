import { BoardSessionRow, HelperCommand, Holder } from '../../core/models/sessions.models';
import { ClaudeInputs, claudeView } from './claude-mode';

const session = (state: BoardSessionRow['state'], extra: Partial<BoardSessionRow> = {}): BoardSessionRow => ({
  id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '2723f394-0000-0000-0000-000000000000', desktopId: null, user: 'me@x',
  machine: 'LAPTOP-1', helperKeyId: 'h1', cwd: null, title: null, state, openIn: 'DESKTOP', lastChatSeq: 0, tokensToday: 0, tokensDay: null,
  current: true, createdAt: '2026-10-18T10:00:00Z', lastActive: '2026-10-18T10:00:00Z', ...extra,
});
const command = (kind: HelperCommand['kind'], state: HelperCommand['state'], result: string | null = null): HelperCommand => ({
  id: 'c1', helperKeyId: 'h1', user: 'me@x', kind, boardId: 'b1', project: 'odeysys', sessionId: 's1', args: '{}', state, result,
  createdAt: '2026-10-18T11:00:00Z', updatedAt: '2026-10-18T11:00:00Z',
});
const none: ClaudeInputs = { held: null, pending: null, session: null, mine: false, elsewhere: false, failed: null, terminalOn: false };

describe('claudeView', () => {
  it('gives each mode its words', () => {
    expect(claudeView(none).label).toBe('▶ Start Claude');
    expect(claudeView({ ...none, session: session('ANSWERING'), mine: true, terminalOn: true }).label).toBe('● Claude on');
    expect(claudeView({ ...none, session: session('STOPPED'), mine: true }).label).toBe('▶ Resume Claude');
    expect(claudeView({ ...none, session: session('ANSWERING'), mine: true, elsewhere: true }).label).toBe('Claude on LAPTOP-1');
    expect(claudeView({ ...none, terminalOn: true }).label).toBe('● Claude on · terminal');
    expect(claudeView({ ...none, held: { user: 'sara@x', machine: 'PC-2' } as Holder }).label).toBe("🔒 sara's Claude");
    expect(claudeView({ ...none, failed: command('START', 'FAILED', 'weekly limit') }).label).toBe("⚠ Claude didn't start");
  });

  it('is busy while a command that changes it is in flight, with the progress as tooltip', () => {
    const v = claudeView({ ...none, pending: command('START', 'TAKEN'), session: session('STARTING', { progress: 'Making the worktree' }), mine: true });
    expect([v.mode, v.label, v.tooltip]).toEqual(['busy', 'Starting Claude…', 'Making the worktree']);
    expect(claudeView({ ...none, pending: command('STOP', 'TAKEN'), session: session('ANSWERING'), mine: true }).label).toBe('Pausing…');
    expect(claudeView({ ...none, pending: command('RELEASE', 'TAKEN') }).label).toBe('Handing back…');
    expect(claudeView({ ...none, pending: command('RESUME', 'QUEUED') }).label).toBe('Waiting for your PC…');
    // opening Desktop does not make the control busy
    expect(claudeView({ ...none, pending: command('OPEN_DESKTOP', 'TAKEN'), session: session('ANSWERING'), mine: true, terminalOn: true }).mode).toBe('on');
  });

  it('is not "on" when nothing listens to the chat, whatever the helper last reported', () => {
    // the runner died (a PC or Desktop restart) - the session still says ANSWERING, the chat has no listener
    const v = claudeView({ ...none, session: session('ANSWERING'), mine: true, terminalOn: false });
    expect([v.mode, v.label]).toEqual(['paused', '▶ Resume Claude']);
    expect(v.tooltip).toContain('nothing listens to its chat');
    // a usage limit is the helper's own word: it stays
    expect(claudeView({ ...none, session: session('WAITING_LIMIT'), mine: true }).label).toBe('● Claude on · usage limit');
  });

  it('forgets a failure once the session answered after it', () => {
    const failed = command('RESUME', 'FAILED', 'x');
    expect(claudeView({ ...none, failed, session: session('ANSWERING', { lastActive: '2026-10-18T12:00:00Z' }), mine: true, terminalOn: true }).mode).toBe('on');
    expect(claudeView({ ...none, failed, session: session('STOPPED'), mine: true }).mode).toBe('failed');
  });
});
