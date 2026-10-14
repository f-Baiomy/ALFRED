import { Inline } from './markdown-blocks';

/**
 * Which way a piece of text reads (board comments, descriptions, briefs): right-to-left when more of its words are
 * Arabic / Hebrew than Latin, left-to-right when more are Latin, by its first letter on a tie, null with no letters at
 * all (the caller keeps the browser's `auto`). Unlike `dir="auto"`, which decides by the first letter only, an
 * Arabic sentence that starts with "POST" or "**9 search**" still reads right-to-left.
 */
export type TextDir = 'ltr' | 'rtl';
/** What the user picked: the text's own direction (auto), or one forced. */
export type DirChoice = 'auto' | TextDir;

const RTL_ONE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const FIRST = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFFA-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

export function textDir(text: string | null | undefined): TextDir | null {
  const t = text ?? '';
  // Words, not letters: an Arabic sentence about code is full of long English terms ("الـsearch", "flight-search/search")
  // but its words - each by its first letter, so "الـuser" is Arabic - are mostly Arabic.
  let rtl = 0;
  let ltr = 0;
  for (const word of t.split(/\s+/)) {
    const first = word.match(FIRST)?.[0];
    if (!first) continue;
    if (RTL_ONE.test(first)) rtl++; else ltr++;
  }
  if (!rtl && !ltr) return null;
  if (rtl !== ltr) return rtl > ltr ? 'rtl' : 'ltr';
  return RTL_ONE.test(t.match(FIRST)?.[0] ?? '') ? 'rtl' : 'ltr';
}

/** The words of inline markdown - code and mentions left out: they say nothing about the language of the sentence. */
export function inlineWords(nodes: readonly Inline[]): string {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'bold': case 'italic': case 'link': return inlineWords(n.children);
      default: return ' ';
    }
  }).join('');
}

/** The direction a block is shown in: the user's choice, else its own, else the browser's `auto`. */
export function blockDir(choice: DirChoice, words: string): TextDir | 'auto' {
  return choice !== 'auto' ? choice : textDir(words) ?? 'auto';
}

/** Auto → right-to-left → left-to-right → auto: the ⇄ switch. */
export function nextChoice(c: DirChoice): DirChoice {
  return c === 'auto' ? 'rtl' : c === 'rtl' ? 'ltr' : 'auto';
}

export function choiceLabel(c: DirChoice): string {
  return c === 'auto' ? '⇄ Auto' : c === 'rtl' ? '← RTL' : '→ LTR';
}
