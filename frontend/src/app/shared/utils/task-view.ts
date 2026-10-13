import {
  CardKind, CardRef, CardStatus, CardSummary, ChecklistFile, ChecklistItem, SessionLogEntry, TestStep,
} from '../../core/models/board.models';

/**
 * The Task view of a session cycle (a cycle is a task - skills/_shared/rules.md §0): the brief split into its sections,
 * each Acceptance item as a requirement with a state, Claude's notes, and where the task stands. Pure functions over
 * what /board already serves (brief, checklist, cards, steps, session log) - the MCP's task_context reads the same
 * things the same way, so the user and every Claude session see one picture.
 */

/** The brief's sections, in the order /alfred-setup writes them. */
export const BRIEF_SECTIONS = ['task', 'description', 'scope', 'out of scope', 'test steps', 'data', 'decisions'] as const;

export interface BriefParts {
  /** The text before the first `##` heading: the one line saying what the task delivers. */
  readonly goal: string;
  /** Known sections by lower-case name. */
  readonly sections: Readonly<Record<string, string>>;
  /** Headings the template does not know, kept as written, in order. */
  readonly other: readonly { readonly title: string; readonly text: string }[];
}

export function briefParts(text: string): BriefParts {
  const sections: Record<string, string> = {};
  const other: { title: string; text: string }[] = [];
  let goal: string[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (title === null) {
      goal = body;
    } else {
      const key = title.trim().toLowerCase();
      const value = body.join('\n').trim();
      if ((BRIEF_SECTIONS as readonly string[]).includes(key)) sections[key] = value;
      else other.push({ title: title.trim(), text: value });
    }
  };
  for (const line of (text ?? '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      title = h[1];
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  // A brief with no sections at all is an older free-text one: show it whole, not as a "goal".
  if (title === null) return { goal: '', sections: {}, other: text.trim() ? [{ title: '', text: text.trim() }] : [] };
  return { goal: goal.join('\n').trim().replace(/^#\s+/, ''), sections, other };
}

/** The bullet / numbered lines of a section, without their markers; a section of plain lines gives those lines. */
export function itemsOf(section: string | undefined): string[] {
  // A template placeholder ("- <what this task changes>") is not an item.
  return (section ?? '').split(/\r?\n/).map((l) => l.trim().replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, '').trim())
    .filter((l) => l.length > 0 && !/^<.*>$/.test(l));
}

export interface Decision {
  readonly date: string | null;
  readonly text: string;
}

/** `## Decisions` lines: "2026-10-12 fare may change …", "12/10 …" or undated. */
export function decisionsOf(section: string | undefined): Decision[] {
  return itemsOf(section).map((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[:\-–·]?\s*(.*)$/.exec(line);
    return m ? { date: m[1], text: m[2] } : { date: null, text: line };
  });
}

/** The ticket ids and the branch named in `## Task`. */
export function taskRefs(section: string | undefined): { tickets: string[]; branch: string | null } {
  const text = section ?? '';
  const tickets = [...new Set(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
  const branch = /branch\W+`?([\w./-]+)`?/i.exec(text)?.[1] ?? /`([\w.-]+\/[\w./-]+)`/.exec(text)?.[1] ?? null;
  return { tickets, branch };
}

// ------------------------------------------------------------------------------------------------------- requirements

/** MET, a BUG, MISSING (not built - a task, not a bug), FIXED (waiting on a re-test), CAN'T TELL, or not checked. */
export type ReqState = 'BUG' | 'MISSING' | 'FIXED' | 'CANT_TELL' | 'UNTESTED' | 'MET';

export const REQ_LABELS: Record<ReqState, string> = {
  BUG: 'BUG', MISSING: 'MISSING', FIXED: 'FIXED · RE-TEST', CANT_TELL: "CAN'T TELL", UNTESTED: 'NOT CHECKED', MET: 'MET',
};

/** Problems first; met last (collapsed). */
const REQ_ORDER: readonly ReqState[] = ['BUG', 'MISSING', 'FIXED', 'CANT_TELL', 'UNTESTED', 'MET'];

export interface Requirement {
  /** R1, R2 … across the spec files, in their order. */
  readonly label: string;
  readonly fileName: string;
  readonly item: ChecklistItem;
  readonly state: ReqState;
  /** The state comes from the user's own mark. */
  readonly byUser: boolean;
  /** The state comes only from Claude's suggestion (grey until accepted). */
  readonly suggested: boolean;
  /** What says so: the user's evidence, else Claude's. */
  readonly evidence: string | null;
  readonly cards: readonly CardRef[];
}

const ACTIVE: readonly CardStatus[] = ['INBOX', 'TO_DO', 'IN_PROGRESS'];

function kindOf(ref: CardRef, kinds: ReadonlyMap<number, CardKind>): CardKind {
  return kinds.get(ref.number) ?? 'BUG';
}

function fromCards(cards: readonly CardRef[], kinds: ReadonlyMap<number, CardKind>): ReqState | null {
  const work = cards.filter((c) => kindOf(c, kinds) === 'BUG' || kindOf(c, kinds) === 'TASK');
  const active = work.filter((c) => ACTIVE.includes(c.status));
  if (active.some((c) => kindOf(c, kinds) === 'BUG')) return 'BUG';
  if (active.length) return 'MISSING';
  if (work.some((c) => c.status === 'FIXED')) return 'FIXED';
  return null;
}

export function requirementsOf(files: readonly ChecklistFile[], cards: readonly CardSummary[]): Requirement[] {
  const kinds = new Map(cards.map((c) => [c.number, c.kind] as const));
  const out: Requirement[] = [];
  let n = 0;
  for (const f of files) {
    for (const item of f.items) {
      n++;
      const linked = item.cards ?? [];
      const byCards = fromCards(linked, kinds);
      const mark = item.mark?.mark ?? null;
      const sg = item.suggestion?.mark ?? null;
      let state: ReqState;
      if (mark === 'PASS') state = 'MET';
      else if (mark === 'CANT_TELL') state = byCards ?? 'CANT_TELL';
      else if (mark === 'FAIL') state = byCards ?? 'BUG';
      else if (byCards) state = byCards;
      else if (sg === 'PASS') state = 'MET';
      else if (sg === 'FAIL') state = 'BUG';
      else if (sg === 'CANT_TELL') state = 'CANT_TELL';
      else state = 'UNTESTED';
      out.push({
        label: `R${n}`, fileName: f.fileName, item, state,
        byUser: !!mark, suggested: !mark && !!sg && !byCards,
        evidence: item.mark?.evidence || item.suggestion?.evidence || null,
        cards: linked,
      });
    }
  }
  return out.sort((a, b) => REQ_ORDER.indexOf(a.state) - REQ_ORDER.indexOf(b.state));
}

export function countStates(reqs: readonly Requirement[]): Record<ReqState, number> {
  const c: Record<ReqState, number> = { BUG: 0, MISSING: 0, FIXED: 0, CANT_TELL: 0, UNTESTED: 0, MET: 0 };
  for (const r of reqs) c[r.state]++;
  return c;
}

// -------------------------------------------------------------------------------------------------------------- notes

export interface TaskNote {
  readonly card: CardSummary;
  /** RISK (flagged), TASK (missing work no requirement names), or NOTE. */
  readonly tag: 'RISK' | 'TASK' | 'NOTE';
  readonly title: string;
}

const NOT_IN_TASK = /^(?:changed,?\s+but\s+)?not\s+in\s+the\s+task\s*[:\-–]\s*/i;

const OPEN = (c: CardSummary) => c.status !== 'CLOSED' && c.status !== 'DONE' && c.status !== 'VERIFIED';

/**
 * Open cards that are not about a requirement: Claude's notes (risks, gaps, edge cases), tasks no requirement names,
 * and "Not in the task: …" notes - code the branch changes that the task never asked for (rules §0).
 */
export function notesOf(cards: readonly CardSummary[], reqs: readonly Requirement[]): { notes: TaskNote[]; notInTask: TaskNote[] } {
  const onReq = new Set(reqs.flatMap((r) => r.cards.map((c) => c.number)));
  const notes: TaskNote[] = [];
  const notInTask: TaskNote[] = [];
  for (const c of cards) {
    if (!OPEN(c) || onReq.has(c.number)) continue;
    if (c.kind === 'NOTE' && NOT_IN_TASK.test(c.title)) {
      notInTask.push({ card: c, tag: 'NOTE', title: c.title.replace(NOT_IN_TASK, '') });
    } else if (c.kind === 'NOTE') {
      notes.push({ card: c, tag: c.flags.includes('RISK') ? 'RISK' : 'NOTE', title: c.title });
    } else if (c.kind === 'TASK') {
      notes.push({ card: c, tag: 'TASK', title: c.title });
    }
  }
  return { notes, notInTask };
}

// ---------------------------------------------------------------------------------------------------- verdict, phase

export const PHASES = ['Coded', 'Verifying', 'Fixed', 'Re-tested', 'Done'] as const;

/** 0 Coded … 4 Done, from the requirements, the cards and whether Claude has looked at all. */
export function phaseOf(reqs: readonly Requirement[], cards: readonly CardSummary[], steps: readonly TestStep[],
                        log: readonly SessionLogEntry[]): number {
  const work = cards.filter((c) => c.kind === 'BUG' || c.kind === 'TASK');
  const active = work.some((c) => ACTIVE.includes(c.status));
  const fixed = work.some((c) => c.status === 'FIXED');
  const allMet = reqs.length > 0 && reqs.every((r) => r.state === 'MET');
  if (allMet && reqs.every((r) => r.byUser) && !active && !fixed) return 4;
  if (!active && !fixed && (allMet || work.some((c) => c.status === 'VERIFIED' || c.status === 'DONE'))) return 3;
  if (!active && fixed) return 2;
  const looked = log.length > 0 || steps.some((s) => s.state !== 'UNTESTED') || reqs.some((r) => r.state !== 'UNTESTED') || cards.length > 0;
  return looked ? 1 : 0;
}

export interface Verdict {
  readonly tone: 'ok' | 'bad' | 'warn' | 'none';
  readonly head: string;
  readonly detail: string;
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one answer on top: does the code match the task? */
export function verdictOf(reqs: readonly Requirement[]): Verdict {
  if (!reqs.length) {
    return { tone: 'none', head: 'No requirements yet', detail: 'add the ticket or a spec with an Acceptance list - /alfred-spec drafts one' };
  }
  const c = countStates(reqs);
  if (c.BUG || c.MISSING) {
    const parts = [c.BUG ? plural(c.BUG, 'bug') : '', c.MISSING ? `${plural(c.MISSING, 'requirement')} missing` : ''].filter(Boolean);
    return { tone: 'bad', head: 'Not yet', detail: parts.join(', ') };
  }
  if (c.FIXED) return { tone: 'warn', head: 'Fixed, not re-tested', detail: `${plural(c.FIXED, 'requirement')} waiting on a re-test` };
  if (c.UNTESTED || c.CANT_TELL) {
    const parts = [c.UNTESTED ? `${c.UNTESTED} not checked yet` : '', c.CANT_TELL ? `${c.CANT_TELL} Alfred can't tell` : ''].filter(Boolean);
    return { tone: 'warn', head: 'Partly checked', detail: `${c.MET} of ${reqs.length} met · ${parts.join(', ')}` };
  }
  const unconfirmed = reqs.filter((r) => !r.byUser).length;
  return unconfirmed
    ? { tone: 'ok', head: 'Looks done', detail: `every requirement met - ${unconfirmed} still to confirm with your mark` }
    : { tone: 'ok', head: 'Yes', detail: 'every requirement met and marked' };
}

export interface DoneCheck {
  readonly ok: boolean;
  readonly text: string;
  readonly value: string;
}

/** The hand-over rule, checked live. */
export function doneWhen(reqs: readonly Requirement[], cards: readonly CardSummary[]): DoneCheck[] {
  const marked = reqs.filter((r) => r.byUser).length;
  const openWork = cards.filter((c) => (c.kind === 'BUG' || c.kind === 'TASK') && ACTIVE.includes(c.status)).length;
  const fixed = cards.filter((c) => (c.kind === 'BUG' || c.kind === 'TASK') && c.status === 'FIXED').length;
  return [
    { ok: reqs.length > 0 && marked === reqs.length, text: 'every requirement marked by you', value: reqs.length ? `${marked} / ${reqs.length}` : '-' },
    { ok: openWork === 0, text: 'no open bug or task', value: String(openWork) },
    { ok: fixed === 0, text: 'every fix re-tested', value: fixed ? `${fixed} waiting` : '-' },
  ];
}

/** Open cards the user has to act on: a question, a proposal, or marked as waiting on them. */
export function needsYou(cards: readonly CardSummary[]): { card: CardSummary; why: string }[] {
  return cards.filter((c) => c.status !== 'CLOSED' && c.status !== 'DONE').flatMap((c) => {
    if (c.proposal) return [{ card: c, why: 'Claude proposes ' + (c.proposal.kind === 'MERGE' ? 'a merge' : c.proposal.kind === 'REOPEN' ? 'reopening it' : c.proposal.status.toLowerCase().replace('_', ' ')) }];
    if (c.kind === 'QUESTION' && c.status === 'INBOX') return [{ card: c, why: 'a question' }];
    if (c.waiting?.who === 'USER') return [{ card: c, why: 'waits on you' }];
    return [];
  });
}
