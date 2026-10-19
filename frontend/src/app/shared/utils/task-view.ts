import {
  BriefComment, CardKind, CardRef, CardStatus, CardSummary, ChecklistFile, ChecklistItem, SessionLogEntry, TestStep,
} from '../../core/models/board.models';
import { textAsMarkdown } from './rich-html';
import { userLabel } from '../../core/links/remote-ref';

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

export function briefParts(stored: string): BriefParts {
  // a brief written in the rich editor is read as the Markdown it shows (docs/board.md "Rich text")
  const text = textAsMarkdown(stored);
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
    // "met" counts what the user's mark or the cards say; a met that is only Claude's suggestion waits under "to decide"
    const met = reqs.filter((r) => r.state === 'MET' && !r.suggested).length;
    const decide = reqs.filter((r) => r.suggested).length;
    const parts = [decide ? `${decide} to decide` : '', c.UNTESTED ? `${c.UNTESTED} not checked yet` : '',
      c.CANT_TELL ? `${c.CANT_TELL} Alfred can't tell` : ''].filter(Boolean);
    return { tone: 'warn', head: 'Partly checked', detail: `${met} of ${reqs.length} met · ${parts.join(', ')}` };
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
    if (c.waiting?.who === 'USER') {
      const who = userLabel(c.id); // another Alfred's card waits on its own people (specs/035)
      return [{ card: c, why: `waits on ${who === 'You' ? 'you' : who}` }];
    }
    return [];
  });
}

// --------------------------------------------------------------------------------------------- the Task tab (specs/024)

/** The Task tab's sections, Requirements first. */
export type TaskTab = 'req' | 'test' | 'brief' | 'runs' | 'files' | 'cycles' | 'items';
export const TASK_TABS: readonly TaskTab[] = ['req', 'test', 'brief', 'runs', 'files', 'cycles', 'items'];

/** A requirement's group in the list: one Claude suggests a mark for is decided first, whatever its state. */
export type ReqGroup = 'DECIDE' | ReqState;

export function groupOf(r: Requirement): ReqGroup {
  return r.suggested ? 'DECIDE' : r.state;
}

export interface GroupInfo {
  readonly key: ReqGroup;
  readonly title: string;
  /** Shown beside the title. */
  readonly hint: string;
  /** What to do with a row of it (ⓘ). */
  readonly tip: string;
}

/** Problems and decisions first, met last (folded). The same words as the Requirements guide. */
export const REQ_GROUPS: readonly GroupInfo[] = [
  { key: 'DECIDE', title: 'Decide', hint: 'Claude suggests a mark; yours decides',
    tip: 'Open the row, read Claude\'s reason, then Accept it or mark it yourself. Nothing counts until you do.' },
  { key: 'BUG', title: 'Bug', hint: 'built but works wrong - a card holds the fix',
    tip: 'Claude fixes it on its card (/alfred-fix); then you re-test.' },
  { key: 'MISSING', title: 'Missing', hint: 'not built yet - a task, not a bug',
    tip: 'Its card says what is missing. Once built, test it again.' },
  { key: 'FIXED', title: 'Re-test', hint: 'fixed - check it again',
    tip: 'Use the app as the card\'s re-test says, then /alfred-verify checks the calls since the fix.' },
  { key: 'CANT_TELL', title: 'Can\'t tell yet', hint: 'the calls don\'t show it; test it, or mark it yourself',
    tip: '0 rows = the search found nothing, so nothing could be checked: add test data and search again. No call yet = do the Test plan step while Claude listens.' },
  { key: 'UNTESTED', title: 'Not checked', hint: 'nothing has tried it yet',
    tip: 'Do its Test plan step while Claude listens, or mark it yourself if you already know.' },
  { key: 'MET', title: 'Met', hint: 'done', tip: 'The calls or your Pass show it works.' },
];

/** The state pill of a row. */
export const STATE_PILLS: Record<ReqGroup, string> = {
  DECIDE: '✦ CLAUDE SUGGESTS', BUG: 'BUG', MISSING: 'MISSING', FIXED: 'RE-TEST', CANT_TELL: 'CAN\'T TELL', UNTESTED: 'NOT CHECKED', MET: '✓ MET',
};

export interface CallPill {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'bad' | '';
  /** Why, on hover. */
  readonly tip: string;
}

/** A short pill for what the calls say about a requirement (specs/018's verdict), with the reason on hover. */
export function callPill(v: { verdict: string; reason: string | null } | null | undefined): CallPill | null {
  if (!v) return null;
  const why = v.reason ? ` - ${v.reason}` : '';
  switch (v.verdict) {
    case 'MET': return { text: 'seen in calls', tone: 'ok', tip: `The calls show it works${why}` };
    case 'WRONG': return { text: 'calls: wrong', tone: 'bad', tip: `A call shows a wrong result${why}` };
    case 'MISSING': return { text: 'calls: missing', tone: 'bad', tip: `A call shows it is not there${why}` };
    case 'NO_DATA': return { text: '0 rows', tone: 'warn',
      tip: `The search ran fine but returned nothing, so Alfred cannot check the result. Add test data and search again${why}` };
    case 'UNKNOWN': return { text: 'calls can\'t tell', tone: '', tip: `The calls do not decide it${why}` };
    case 'NOT_EXERCISED': return { text: 'no call yet', tone: '', tip: 'No call has tried this yet: do the matching Test plan step while Claude listens.' };
    case 'MANUAL': return { text: 'checked by hand', tone: '', tip: 'No call can show this (what a page lists, how it looks): check it in the app and mark it.' };
    case 'NO_EVIDENCE': return { text: 'no checks yet', tone: '',
      tip: 'Nobody has said how the calls show this yet - open the row, then "how the calls show it", or let /alfred-listen draft it.' };
    default: return null;
  }
}

export interface NeedItem {
  readonly text: string;
  /** Where it leads: a tab (with a Requirements filter) or a card. */
  readonly tab?: TaskTab;
  readonly filter?: ReqGroup;
  readonly card?: CardSummary;
  readonly tone?: 'bad' | '';
}

/** Everything on the task waiting for the user, each leading where it is dealt with. */
export function needItems(reqs: readonly Requirement[], cards: readonly CardSummary[], steps: readonly TestStep[], briefAsks: number): NeedItem[] {
  const out: NeedItem[] = [];
  const sugg = reqs.filter((r) => r.suggested).length;
  if (sugg) out.push({ text: `✦ ${plural(sugg, 'suggestion')} to accept`, tab: 'req', filter: 'DECIDE' });
  const c = countStates(reqs);
  const bugs = reqs.filter((r) => !r.suggested && r.state === 'BUG').length;
  if (bugs) out.push({ text: `✗ ${plural(bugs, 'requirement')} failed`, tab: 'req', filter: 'BUG', tone: 'bad' });
  if (c.FIXED) out.push({ text: `${plural(c.FIXED, 'fix', 'fixes')} to re-test`, tab: 'req', filter: 'FIXED' });
  const unchecked = reqs.filter((r) => !r.suggested && r.state === 'UNTESTED').length;
  if (unchecked) out.push({ text: `${plural(unchecked, 'requirement')} not checked yet`, tab: 'req', filter: 'UNTESTED' });
  if (briefAsks) out.push({ text: `💬 Claude asks about the brief${briefAsks > 1 ? ` (${briefAsks})` : ''}`, tab: 'brief' });
  for (const n of needsYou(cards)) out.push({ text: `#${n.card.number} ${n.card.title} - ${n.why}`, card: n.card });
  const left = steps.filter((s) => s.state !== 'SEEN').length;
  if (steps.length && left) out.push({ text: `${left} of ${steps.length} test steps not done`, tab: 'test' });
  return out;
}

// ----------------------------------------------------------------------------------------------------- brief comments

export interface BriefThread {
  readonly root: BriefComment;
  readonly replies: readonly BriefComment[];
  /** Claude asked and the user has not answered since. */
  readonly asksYou: boolean;
}

/** The brief's comments as threads, oldest first; resolved ones apart. */
export function briefThreads(comments: readonly BriefComment[]): { open: BriefThread[]; resolved: BriefThread[] } {
  const replies = new Map<number, BriefComment[]>();
  for (const c of comments) if (c.replyTo != null) replies.set(c.replyTo, [...(replies.get(c.replyTo) ?? []), c]);
  const open: BriefThread[] = [];
  const resolved: BriefThread[] = [];
  for (const root of comments.filter((c) => c.replyTo == null)) {
    const rs = replies.get(root.id) ?? [];
    const all = [root, ...rs];
    let lastAsk = -1;
    all.forEach((c, i) => { if (c.asks) lastAsk = i; });
    const asksYou = lastAsk >= 0 && !all.slice(lastAsk + 1).some((c) => c.actor === 'USER');
    (root.resolvedAt ? resolved : open).push({ root, replies: rs, asksYou: asksYou && !root.resolvedAt });
  }
  return { open, resolved };
}

/** Where `quote` sits in `text`, whitespace runs matched loosely (a selection across lines reads its breaks as spaces). */
export function findLoose(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  const pattern = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const m = new RegExp(pattern).exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

// ------------------------------------------------------------------------------------------------------------ guides

/** "ⓘ How this works" per tab: what the section is, and how to decide in it. */
export const TAB_GUIDES: Record<TaskTab, { title: string; lead: string; points: readonly { if: string; then: string }[] }> = {
  req: {
    title: 'Requirements - what the task must do, and whether the code does it',
    lead: 'Each row is one Acceptance line of a spec file - the ticket\'s criteria. Alfred judges a row from the calls you record while using '
      + 'the app; when the calls cannot show it, you decide with Pass / Fail / Can\'t tell. Your mark is what counts - Claude only suggests.',
    points: [
      { if: '✦ Claude suggests', then: 'open the row and read its reason. Agree? Accept. Else mark it yourself.' },
      { if: '0 rows', then: 'the search found nothing to check: add test data (Test plan) and search again, or mark Can\'t tell.' },
      { if: 'no call yet', then: 'do the matching Test plan step while Claude listens.' },
      { if: 'you saw it work', then: '✓ Pass, and say how in your evidence.' },
      { if: 'you saw it wrong', then: '✗ Fail - then ask Claude to fix it on a card.' },
      { if: 'it cannot be shown', then: '? Can\'t tell, with a note why.' },
    ],
  },
  test: {
    title: 'Test plan - what to do in the app, and when the task is finished',
    lead: 'Do the steps in the app while Claude listens (Run → Check while I test): a step gets ✓ and its calls when Claude sees them. '
      + 'Set up the test data first, or searches come back with 0 rows. Done when is the hand-over rule: all three ✓, then the hand-over report.',
    points: [
      { if: 'a step says not yet', then: 'nobody has done it with Claude listening - do it now.' },
      { if: 'a step failed', then: 'its card says what went wrong.' },
      { if: 'Done when shows ✗', then: 'it says what is left; click it to go there.' },
    ],
  },
  brief: {
    title: 'Brief - the task in words, the source for everything else',
    lead: 'The ticket as written, what is in and out of scope, and the decisions made on the way - every Claude session reads them first and '
      + 'must follow them. Select a passage to comment on it, or comment on the whole brief.',
    points: [
      { if: 'Claude asks', then: 'answer in the thread - your answer is what the next session reads.' },
      { if: 'Claude suggests a rewording', then: 'Apply changes the brief (Restore previous undoes it); Dismiss keeps it as it is.' },
      { if: 'a thread is settled', then: '✓ Resolve it; resolved threads fold away and can be reopened.' },
    ],
  },
  runs: {
    title: 'Claude\'s runs - the session log',
    lead: 'Every skill Claude runs on this task leaves one entry: Did, Found, Next. Read the newest one\'s Next when you come back; nothing '
      + 'here needs a decision unless its Next says so.',
    points: [],
  },
  files: {
    title: 'Spec & files - where the requirements come from',
    lead: 'A spec file (.md or .txt) holds the ticket\'s Acceptance lines - each becomes a row in Requirements. Drop the ticket\'s spec here, '
      + 'or let Run → Write the requirements draft one from the brief. Replacing a file keeps the previous one. Files attached here go with the task.',
    points: [],
  },
  cycles: {
    title: 'Cycles - the recordings of this task',
    lead: 'A cycle only holds calls: what the app did while you tested. The task - brief, requirements, cards - lives on this board. '
      + 'Record a cycle while you do the Test plan; a re-test cycle checks a fix.',
    points: [
      { if: 'another cycle records this project', then: 'pause it first - one recording per project.' },
    ],
  },
  items: {
    title: 'Related items - the work items this task is for',
    lead: 'The main work item and its tree (parents above, children below, one hop of links), plus items added by hand. The main and the '
      + 'items on cards are kept in full and compared on each sync; the rest are read live. New items in the tree, watch rule matches and hook '
      + 'pings arrive in Incoming - you decide: a new card, a link, or Ignore.',
    points: [
      { if: 'an item shows ● changed', then: 'review what changed; Keep the new copy when you have read it.' },
      { if: 'something arrives in Incoming', then: 'New card, Link to card, or Ignore - Claude only proposes.' },
    ],
  },
};
