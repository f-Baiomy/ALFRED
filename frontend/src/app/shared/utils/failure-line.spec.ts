import { failureLine } from './failure-line';

describe('failureLine', () => {
  it('words the failures seen on 2026-10-18', () => {
    expect(failureLine("claude exited 1: You've hit your weekly limit · resets Oct 20, 5pm (Africa/Cairo)").text)
      .toBe('The Claude account on your PC hit its weekly limit - it resets Oct 20, 5pm (Africa/Cairo).');
    expect(failureLine('NO_FOLDER: no repo folder for odeysys on LAPTOP-34BNETR7 - pick one, or set it in 👤 Me').text)
      .toBe('no repo folder for odeysys on LAPTOP-34BNETR7.');
    expect(failureLine('NOT_HERE: session 32c74989 is not on LAPTOP-34BNETR7 (it was on LAPTOP-34BNETR7)').text).toBe('That session is not on this PC.');
    expect(failureLine('claude exited 1: Ignoring --allowedTools rule "mcp__*": Wildcard tool name…\nError: Input must be provided either through stdin').text)
      .toBe('Claude got no prompt (an older helper).');
    expect(failureLine('Claude Code on this PC is not signed in. Run claude').fix).toContain('sign in');
  });

  it('shows the first useful line of anything else, and never an empty sentence', () => {
    expect(failureLine('claude exited 2: Ignoring --allowedTools rule "x"\nboom happened\nmore').text).toBe('boom happened');
    expect(failureLine('').text).toBe('It stopped without saying why.');
    expect(failureLine(null).fix).toBeNull();
  });
});
