import { BoardStage, StageStep, StepKind, stageCommand } from '../../core/models/board.models';

/**
 * The Next card's words (specs/032 D2). The backend decides the step (`BoardStage.of` - the one rule) and sends its
 * numbers; this table says it in plain words for people. Nothing here decides what comes next.
 */
export interface StepCopy {
  readonly kind: StepKind;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  /** Finishes "Ask Claude to …" / "Start Claude and …" / "Record and …". */
  readonly verb: string;
  readonly skill: string | null;
  readonly command: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The step, from `step` when the backend sends it, else read back from the older `next` text. */
export function stepOf(stage: BoardStage): StageStep {
  if (stage.step) return stage.step;
  const command = stageCommand(stage.next);
  const skill = command ? command.split(' ')[0].slice(1) : null;
  const n = Number((stage.next.split(stage.ref).join(' ').match(/(?<![#\w])(\d+)\b/) ?? [])[1] ?? 0);
  if (stage.stage === 'TEST') return { kind: 'RECORD', skill: 'alfred-listen', command: `/alfred-listen ${stage.ref}`, count: n };
  if (!skill && stage.stage === 'CODE') return { kind: 'CLAUDE', skill: 'alfred-fix', command: `/alfred-fix ${stage.ref}`, count: n };
  return skill ? { kind: 'CLAUDE', skill, command, count: n } : { kind: 'USER', skill: null, command: null, count: n };
}

export function stepCopy(stage: BoardStage): StepCopy {
  const step = stepOf(stage);
  const kind: StepKind = step.kind === 'CLAUDE' || step.kind === 'RECORD' ? step.kind : 'USER';
  const n = step.count;
  const ref = stage.ref;
  const base = { kind, skill: step.skill, command: step.command };
  if (kind === 'USER') {
    return { ...base, icon: '⚑', title: `Answer the ${plural(n, 'question')} waiting on you`,
      detail: 'Claude asked or proposed something on the cards. Your answer decides what happens to them - open them and answer.', verb: 'answer' };
  }
  if (kind === 'RECORD') {
    return { ...base, icon: '●', title: 'Test it in the app',
      detail: `Press Record and use the app as a user would. Claude watches every call while you test and adds a card for anything wrong`
        + `${n ? ` - ${plural(n, 'requirement')} still to test` : ''}.`, verb: 'watch while I test' };
  }
  switch (step.skill) {
    case 'alfred-setup':
      return { ...base, icon: '✎', title: 'Define the task',
        detail: `Claude reads ${ref} and its child items, then drafts the brief, the requirements, the test steps and the cards. Nothing is saved until you press Save all.`,
        verb: 'define it' };
    case 'alfred-spec':
      return { ...base, icon: '✎', title: 'Write the requirements',
        detail: 'Claude drafts an Acceptance list from the brief, so the calls can show whether the task works. You review it before it is saved.',
        verb: 'draft them' };
    case 'alfred-triage':
      return { ...base, icon: '⇅', title: `Sort the ${plural(n, 'new card')}`,
        detail: 'Claude goes through the Inbox with you, one card at a time: what it found, why, and what it suggests. You decide: To do, Fine, or Not in this flow.',
        verb: 'triage with me' };
    case 'alfred-fix':
      return { ...base, icon: '⚒', title: `Fix the ${plural(n, 'To do card')}`,
        detail: 'Claude posts a plan for each card and waits for your Go, then makes the smallest fix, runs the tests and records the fix on the card. Writing it yourself? Verify finds it.',
        verb: 'fix them' };
    case 'alfred-verify':
      return stage.stage === 'VERIFY' && stage.counts.fixed === 0
        ? { ...base, icon: '✓', title: `Mark the ${plural(n, 'remaining requirement')}`,
          detail: 'Claude suggests a mark for each requirement from the calls and the code. You accept or change each one on the Task tab.', verb: 'suggest the marks' }
        : { ...base, icon: '✓', title: `Check the ${plural(n, 'fixed card')}`,
          detail: 'Claude checks each fix in the code and in the calls since the fix, then proposes Verified or says what still fails.', verb: 'verify' };
    case 'alfred-report':
      return { ...base, icon: '⚑', title: 'Close the task',
        detail: `Every card is settled. Claude writes the summary and prepares the update for ${ref}. Nothing is sent until you approve it.`,
        verb: 'write the close-out' };
    default:
      return { ...base, icon: '▶', title: stage.next.split(' - ')[0], detail: stage.next.split(' - ').slice(1).join(' - '), verb: 'do it' };
  }
}

/** Every step a board can run, for "Other steps ▾" - plain name, what it does, and its command for this board. */
export function otherSteps(ref: string): { skill: string; label: string; what: string; command: string }[] {
  return [
    { skill: 'alfred-setup', label: 'Define or re-define', what: 'brief, requirements, test steps and cards' },
    { skill: 'alfred-spec', label: 'Write or change the spec', what: 'the Acceptance list, one item or all' },
    { skill: 'alfred-triage', label: 'Triage the Inbox', what: 'one card at a time, with you' },
    { skill: 'alfred-fix', label: 'Fix the To do cards', what: 'a plan first, then the smallest fix' },
    { skill: 'alfred-verify', label: 'Verify the fixes', what: 'in the code and in the calls' },
    { skill: 'alfred-listen', label: 'Listen while you test', what: 'checks every new call of the recording' },
    { skill: 'alfred-report', label: 'Report', what: 'found, fixed, verified, still open' },
  ].map((s) => ({ ...s, command: `/${s.skill} ${ref}` }));
}
