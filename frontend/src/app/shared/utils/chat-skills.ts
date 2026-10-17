/**
 * The "/" list of the chat composer (specs/022 FR-022): every shipped /alfred-* skill except the two that run the chat
 * (alfred-live, alfred-listen). The same names as skills/alfred-live/chat.mjs CHAT_SKILLS and alfred_skill.py SKILLS -
 * tests/python/test_alfred_skill.py fails when they drift.
 */
export interface ChatSkill {
  readonly name: string;
  readonly what: string;
}

export const CHAT_SKILLS: readonly ChatSkill[] = [
  { name: 'alfred-guide', what: 'how to use Alfred with Claude, the QA flow' },
  { name: 'alfred-connect', what: 'connect Claude Code to an Alfred' },
  { name: 'alfred-setup', what: 'start a QA task: check capture, brief, steps' },
  { name: 'alfred-spec', what: "write or change the cycle's brief or spec files" },
  { name: 'alfred-review', what: 'review the recorded cycle against the spec' },
  { name: 'alfred-triage', what: 'sort the Inbox together - investigated, worst first, with a confidence on each advice' },
  { name: 'alfred-sync', what: 'catch up with what you did on the board' },
  { name: 'alfred-fix', what: 'fix the cards you choose' },
  { name: 'alfred-verify', what: 'verify Fixed cards against the live calls' },
  { name: 'alfred-status', what: 'where everything stands, what waits on you' },
  { name: 'alfred-resume', what: 'pick up a task where it stands, then the next step' },
  { name: 'alfred-report', what: 'summarise the work for a stand-up or a PR' },
  { name: 'alfred-ask', what: 'answer a question asked from the board' },
  { name: 'alfred-team', what: "the team's tracker: search, link, start, tell it (you approve)" },
  { name: 'alfred-update-skills', what: 'update the /alfred-* skills on this machine' },
];

/** `/alfred-fix 35 42` → { skill: 'alfred-fix', args: '35 42' } when the name is in the list. */
export function slashSkill(text: string): { skill: string; args: string } | null {
  const m = /^\/(alfred-[a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !CHAT_SKILLS.some((s) => s.name === m[1])) return null;
  return { skill: m[1], args: (m[2] ?? '').trim() };
}

/** The skills whose name starts with what follows a leading "/". */
export function skillsMatching(text: string): readonly ChatSkill[] {
  const m = /^\/([a-z-]*)$/.exec(text.trim());
  if (!m) return [];
  const q = m[1].replace(/^alfred-?/, '');
  return CHAT_SKILLS.filter((s) => s.name.slice(7).startsWith(q));
}
