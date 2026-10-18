/**
 * A helper command's FAILED result in one plain sentence and what to do (specs/032 D9) - the Claude button's
 * "⚠ Claude didn't start" and the red banners. Known causes are worded; anything else shows its first line.
 */
export interface FailureLine {
  readonly text: string;
  readonly fix: string | null;
}

export function failureLine(result: string | null | undefined): FailureLine {
  const r = (result ?? '').trim();
  const limit = r.match(/hit your (weekly|daily|usage|session) limit[^·\n]*·?\s*(resets [^\n]+)?/i);
  if (limit) {
    return { text: `The Claude account on your PC hit its ${limit[1].toLowerCase()} limit${limit[2] ? ` - it ${limit[2].trim().replace(/\.$/, '')}` : ''}.`,
      fix: 'Sign Claude Code in with another account (claude /login), or wait for the reset.' };
  }
  if (/not (signed|logged) in|please run \/login|invalid api key|authentication/i.test(r)) {
    return { text: 'Claude Code is not signed in on your PC.', fix: 'Run claude once in a terminal and sign in, then try again.' };
  }
  const folder = r.match(/NO_FOLDER:\s*([^\n]+)/);
  if (folder) return { text: folder[1].replace(/ - pick one.*$/, '.'), fix: 'Pick the folder, or set it in My settings.' };
  if (/NOT_HERE/.test(r)) {
    return { text: 'That session is not on this PC.', fix: 'Start a fresh session here, or continue it on the PC where it ran.' };
  }
  if (/Input must be provided/i.test(r)) {
    return { text: 'Claude got no prompt (an older helper).', fix: 'Try again - the helper updates itself from Alfred.' };
  }
  if (/helper (is )?offline|not connected|fetch failed|ECONNREFUSED/i.test(r)) {
    return { text: 'Your PC is not connected to Alfred.', fix: 'Start the Alfred helper (Connect this PC repairs it).' };
  }
  if (/is not on the PATH|Claude Code is not on this PC/i.test(r)) {
    return { text: 'Claude Code is not installed on your PC.', fix: 'Install Claude Code, sign in, then try again.' };
  }
  const first = r.replace(/^claude exited \d+:\s*/i, '').split('\n').map((l) => l.trim()).find((l) => l && !/^Ignoring --allowedTools/.test(l)) ?? '';
  return { text: first ? first.slice(0, 200) : 'It stopped without saying why.', fix: null };
}
