import { CardKind, Flag } from '../../core/models/board.models';

/**
 * One quick-add line to a card: `bug! discount not saved #urgent`. The backend's QuickAddParser does the same; both run
 * specs/014-task-board/vectors/quick-add.json. Used here for the live preview under the quick-add bar.
 */
export interface QuickAdd {
  readonly kind: CardKind;
  /** Null when nothing is left once prefix and flags are removed. */
  readonly title: string | null;
  readonly flags: readonly Flag[];
}

const PREFIXES: readonly [string, CardKind][] = [['bug!', 'BUG'], ['task!', 'TASK'], ['note!', 'NOTE']];
const FLAG_WORDS: Record<string, Flag> = {
  '#urgent': 'URGENT', '#risk': 'RISK', '#blocker': 'BLOCKER', '#impact': 'AFFECTS_PROJECT', '#decision': 'NEEDS_DECISION',
};
const FLAG_ORDER: readonly Flag[] = ['URGENT', 'RISK', 'BLOCKER', 'AFFECTS_PROJECT', 'NEEDS_DECISION'];

export function parseQuickAdd(line: string): QuickAdd {
  let rest = (line ?? '').trim();
  let kind: CardKind = 'TASK';
  let prefixed = false;
  const lower = rest.toLowerCase();
  for (const [prefix, k] of PREFIXES) {
    if (lower.startsWith(prefix)) {
      kind = k;
      rest = rest.slice(prefix.length);
      prefixed = true;
      break;
    }
  }
  if (!prefixed && rest.startsWith('?')) {
    kind = 'QUESTION';
    rest = rest.slice(1);
  }
  const flags = new Set<Flag>();
  const words: string[] = [];
  for (const word of rest.trim().split(/\s+/)) {
    if (!word) continue;
    const flag = FLAG_WORDS[word.toLowerCase()];
    if (flag) flags.add(flag);
    else words.push(word);
  }
  const title = words.join(' ');
  return { kind, title: title || null, flags: FLAG_ORDER.filter((f) => flags.has(f)) };
}
