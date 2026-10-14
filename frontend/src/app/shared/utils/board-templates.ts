/**
 * Templates for board texts (docs/board.md "Rich text"): one click gives the structure of a bug report, a fix plan, a
 * re-test result or a question - written in the board's Markdown, so Claude's skills (skills/_shared/rules.md) use the
 * same headings and a card reads the same whoever wrote it. The user can change them (kept in this browser).
 */
export interface BoardTemplate {
  readonly name: string;
  readonly icon: string;
  readonly text: string;
}

export const DEFAULT_TEMPLATES: readonly BoardTemplate[] = [
  { name: 'Bug report', icon: '🐞', text: '### What happened\nWhat you saw.\n\n### Expected\nWhat should have happened.\n\n### Evidence\n- \n\n### Steps\n1. ' },
  { name: 'Fix plan', icon: '🛠', text: '### Cause\nWhy it happens.\n\n### Change\nWhat changes, where.\n\n> [!WARNING] Risk\n> What else it can touch.\n\n### How to verify\n- [ ] ' },
  { name: 'Re-test result', icon: '✔', text: '### Re-test\n| Check | Before | After |\n| --- | --- | --- |\n| | | |\n\n> [!FIXED] Verdict\n> [ok] fixed - or what is still wrong.' },
  { name: 'Question', icon: '❓', text: '### Context\nWhat I am looking at.\n\n### Options\n1. \n2. \n\n> [!NEXT] My recommendation\n> Which one and why.' },
];

const KEY = 'alfred.board.templates';

export function loadTemplates(): readonly BoardTemplate[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as BoardTemplate[] | null;
    if (Array.isArray(saved) && saved.every((t) => t && typeof t.name === 'string' && typeof t.text === 'string')) {
      return saved.map((t) => ({ name: t.name, icon: t.icon || '▤', text: t.text }));
    }
  } catch { /* none, or not readable here */ }
  return DEFAULT_TEMPLATES;
}

export function saveTemplates(templates: readonly BoardTemplate[] | null): void {
  try {
    if (templates) localStorage.setItem(KEY, JSON.stringify(templates)); else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
}
