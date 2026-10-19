import { ActivityEntry, BoardQuestion, QuestionAnswer } from '../../core/models/board.models';

/**
 * Claude's questions and the user's answers as board text (specs/019, docs/board.md "Questions"). A question comment is
 * `**Question** <first question>` and, when Claude asked with options, a ```questions block of JSON; an answer comment
 * is `**Answers** Steps: … · Checks: …` and a ```answers block. The text is the source of truth - the backend reads it
 * the same way (`QuestionBlocks`).
 */
export interface AskOption {
  readonly label: string;
  readonly description?: string;
  /** What Claude does if this option is picked. */
  readonly then?: string;
  readonly recommended?: boolean;
  /** On the recommended option (triage): how sure Claude is - high, medium or low. */
  readonly confidence?: string;
  /** Shown on hover: what changes, the effect on the recorded calls, the acceptance items covered, why. */
  readonly preview?: string;
  readonly followUp?: AskQuestion;
}

export interface AskQuestion {
  readonly header: string;
  readonly question: string;
  readonly why?: string;
  /** The evidence under the question (specs/037): board text - pictures, tables, charts, calls, spec lines. */
  readonly details?: string;
  readonly multiSelect?: boolean;
  readonly options: readonly AskOption[];
  /** Triage: what Claude checked before advising. */
  readonly checked?: string;
  /** Triage: where the card ranks in the Inbox, worst first. */
  readonly severity?: { readonly rank: number; readonly of?: number; readonly note?: string };
  /** Triage: Inbox cards of the same root cause to merge into this one. */
  readonly group?: readonly number[];
}

export interface AskBlock {
  /** The comment the questions are about (its id). */
  readonly about?: number;
  /** The answer that raised them: its comment id and which of its answers. */
  readonly because?: { readonly entry: number; readonly header?: string };
  readonly questions: readonly AskQuestion[];
}

/** One question to answer in the dialog: as the board keeps it, with what Claude wrote for it. */
export interface DialogQuestion {
  readonly key: string;
  readonly entryId: number;
  readonly row: BoardQuestion;
  readonly ask: AskQuestion;
  readonly block: AskBlock | null;
  /** A follow-up: the header and option of the question that opens it. */
  readonly parent: { readonly header: string; readonly option: string } | null;
}

const FENCE = /^```(questions|answers)[ \t]*\n([\s\S]*?)\n```[ \t]*$/m;

function block(text: string | null | undefined, lang: 'questions' | 'answers'): Record<string, unknown> | null {
  if (!text) return null;
  const all: string = text;
  const re = new RegExp(FENCE.source, 'gm');
  for (let m = re.exec(all); m; m = re.exec(all)) {
    if (m[1] !== lang) continue;
    try {
      const v = JSON.parse(m[2]);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The text without its ```questions / ```answers block - what the thread shows above the block's own view. */
export function withoutBlocks(text: string | null | undefined): string {
  return (text ?? '').replace(/\n*```(questions|answers)[ \t]*\n[\s\S]*?\n```[ \t]*$/gm, '').trimEnd();
}

export function askBlock(text: string | null | undefined): AskBlock | null {
  const b = block(text, 'questions');
  const qs = b?.['questions'];
  if (!Array.isArray(qs) || !qs.length) return null;
  const question = (q: any): AskQuestion => ({
    header: String(q?.header ?? '').trim(), question: String(q?.question ?? ''), why: q?.why ? String(q.why) : undefined,
    ...(typeof q?.details === 'string' && q.details.trim() ? { details: String(q.details) } : {}),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any): AskOption => ({
      label: String(o?.label ?? ''), description: o?.description ? String(o.description) : undefined, then: o?.then ? String(o.then) : undefined,
      recommended: !!o?.recommended, preview: o?.preview ? String(o.preview) : undefined,
      ...(o?.recommended && ['high', 'medium', 'low'].includes(String(o?.confidence ?? '').toLowerCase()) ? { confidence: String(o.confidence).toLowerCase() } : {}),
      followUp: o?.followUp && typeof o.followUp === 'object' ? question(o.followUp) : undefined,
    })),
    ...(q?.checked ? { checked: String(q.checked) } : {}),
    ...(Number(q?.severity?.rank) > 0 ? { severity: { rank: Number(q.severity.rank), ...(Number(q.severity.of) > 0 ? { of: Number(q.severity.of) } : {}),
      ...(q.severity.note ? { note: String(q.severity.note) } : {}) } } : {}),
    ...(Array.isArray(q?.group) && q.group.length ? { group: q.group.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) } : {}),
  });
  const because = b!['because'] as { entry?: unknown; header?: unknown } | undefined;
  return {
    about: typeof b!['about'] === 'number' ? (b!['about'] as number) : undefined,
    because: because && typeof because.entry === 'number' ? { entry: because.entry, header: because.header ? String(because.header) : undefined } : undefined,
    questions: qs.map(question).map((q, i) => (q.header ? q : { ...q, header: `Q${i + 1}` })),
  };
}

/** The answers of an answer comment, by header. */
export function answersBlock(text: string | null | undefined): Record<string, QuestionAnswer> {
  const b = block(text, 'answers');
  const out: Record<string, QuestionAnswer> = {};
  for (const [header, v] of Object.entries(b ?? {})) {
    const a = v as Record<string, unknown>;
    out[header] = {
      chose: Array.isArray(a?.['chose']) ? (a['chose'] as unknown[]).map(String) : [],
      other: typeof a?.['other'] === 'string' ? (a['other'] as string) : undefined,
      note: typeof a?.['note'] === 'string' ? (a['note'] as string) : undefined,
      later: typeof a?.['later'] === 'string' ? (a['later'] as string) : undefined,
    };
  }
  return out;
}

/** A question as asked: in its block (a follow-up by its header) or, with no block, the comment's own text and no options. */
function askFor(row: BoardQuestion, b: AskBlock | null, entry: ActivityEntry | undefined): AskQuestion {
  const all = b ? [...b.questions, ...b.questions.flatMap((q) => q.options.map((o) => o.followUp).filter((f): f is AskQuestion => !!f))] : [];
  return all.find((q) => q.header.toLowerCase() === row.header.toLowerCase())
    ?? { header: row.header, question: b ? row.text : withoutBlocks(entry?.text).replace(/^\*\*Question\*\*\s*/, '') || row.text, options: [] };
}

/** Whether a question is open now: OPEN, or put off until a time that has come. */
export function isOpenNow(q: BoardQuestion, now = Date.now()): boolean {
  return q.state === 'OPEN' || (q.state === 'LATER' && !!q.laterUntil && Date.parse(q.laterUntil) <= now);
}

/**
 * The dialog's questions: the open ones and every PENDING follow-up (shown only while its option is picked), in the
 * order Claude asked them, each with what Claude wrote for it.
 */
export function dialogQuestions(rows: readonly BoardQuestion[], history: readonly ActivityEntry[], now = Date.now()): DialogQuestion[] {
  const byId = new Map(history.map((e) => [e.id, e]));
  const out: DialogQuestion[] = [];
  const sorted = [...rows].sort((a, b) => a.entryId - b.entryId || a.idx - b.idx);
  for (const row of sorted) {
    if (!isOpenNow(row, now) && row.state !== 'PENDING') continue;
    const entry = byId.get(row.entryId);
    const b = askBlock(entry?.text);
    const parentRow = row.parentIdx == null ? null : rows.find((r) => r.entryId === row.entryId && r.idx === row.parentIdx) ?? null;
    if (row.state === 'PENDING' && (!parentRow || !isOpenNow(parentRow, now))) continue;
    out.push({ key: `${row.entryId}:${row.idx}`, entryId: row.entryId, row, ask: askFor(row, b, entry), block: b,
      parent: parentRow && row.parentOption != null ? { header: parentRow.header, option: row.parentOption } : null });
  }
  return out;
}

/** One question as the thread shows it: what was picked, and whether it is answered, open, put off or withdrawn. */
export interface QuestionLine {
  readonly header: string;
  readonly question: string;
  readonly followUp: boolean;
  readonly options: readonly { readonly label: string; readonly picked: boolean; readonly recommended: boolean; readonly confidence?: string }[];
  readonly state: 'answered' | 'open' | 'later' | 'withdrawn';
  /** Triage: what Claude checked before advising. */
  readonly checked?: string;
  readonly other?: string;
  readonly note?: string;
}

/** The headers a Claude `**Withdrawn** Steps, Plan - reason` reply takes back. */
function withdrawnHeaders(text: string | null): string[] {
  const m = /^\*\*Withdrawn\*\*\s+(.*?)\s+-\s/.exec(text ?? '');
  return m ? m[1].split(/,\s*/).map((h) => h.toLowerCase()) : [];
}

/**
 * A question comment's questions with the answers its replies hold - read from the text alone (the ```answers blocks and
 * Claude's Withdrawn replies), so the thread and the exports need no extra request. A follow-up shows once its option
 * was picked. Null for a comment with no ```questions block.
 */
export function questionLines(entry: ActivityEntry, replies: readonly ActivityEntry[]): QuestionLine[] | null {
  const b = askBlock(entry.text);
  if (!b) return null;
  const given: Record<string, QuestionAnswer> = {};
  const withdrawn = new Set<string>();
  for (const r of replies) {
    if (r.actor === 'USER') {
      for (const [h, a] of Object.entries(answersBlock(r.text))) given[h.toLowerCase()] = a;
    } else if (r.actor === 'CLAUDE') {
      withdrawnHeaders(r.text).forEach((h) => withdrawn.add(h));
    }
  }
  const line = (q: AskQuestion, followUp: boolean): QuestionLine => {
    const a = given[q.header.toLowerCase()];
    const state = withdrawn.has(q.header.toLowerCase()) ? 'withdrawn' : !a ? 'open' : a.later ? 'later' : 'answered';
    const chose = state === 'answered' ? a?.chose ?? [] : [];
    return { header: q.header, question: q.question, followUp, state,
      options: q.options.map((o) => ({ label: o.label, picked: chose.includes(o.label), recommended: !!o.recommended,
        ...(o.confidence ? { confidence: o.confidence } : {}) })),
      ...(q.checked ? { checked: q.checked } : {}),
      ...(state === 'answered' && a?.other ? { other: a.other } : {}), ...(state === 'answered' && a?.note ? { note: a.note } : {}) };
  };
  const out: QuestionLine[] = [];
  for (const q of b.questions) {
    const l = line(q, false);
    out.push(l);
    for (const o of q.options) {
      if (o.followUp && l.options.find((x) => x.label === o.label)?.picked) out.push(line(o.followUp, true));
    }
  }
  return out;
}

/** Every question of a question comment is answered or withdrawn (a put-off one is not); a comment with no block: null. */
export function allAnswered(entry: ActivityEntry, replies: readonly ActivityEntry[]): boolean | null {
  const lines = questionLines(entry, replies);
  return lines ? lines.every((l) => l.state === 'answered' || l.state === 'withdrawn') : null;
}

/** What a question's details hold, for its summary line: "1 screenshot · 1 chart · 1 table" (specs/037). */
export function detailsSummary(details: string | null | undefined): string {
  if (!details) return '';
  const count = (re: RegExp) => (details.match(re) ?? []).length;
  const parts: string[] = [];
  const pictures = count(/!\[[^\]]*\]\(\/board\/images\/[^)]+\)|<img\b/gi);
  const charts = count(/^```chart\b/gim);
  const stats = count(/^```stats\b/gim);
  const tables = count(/^[ \t]*\|[^\n]*\|[ \t]*\n[ \t]*\|[ \t]*:?-{3,}/gm) + count(/<table\b/gi);
  const calls = count(/@\[call:/g) + count(/^```calls\b/gim);
  if (pictures) parts.push(`${pictures} screenshot${pictures === 1 ? '' : 's'}`);
  if (charts) parts.push(`${charts} chart${charts === 1 ? '' : 's'}`);
  if (stats) parts.push(`${stats} stat block${stats === 1 ? '' : 's'}`);
  if (tables) parts.push(`${tables} table${tables === 1 ? '' : 's'}`);
  if (calls) parts.push(`${calls} call${calls === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

