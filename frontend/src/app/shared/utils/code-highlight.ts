/**
 * Colours for a code block on the board (docs/board.md "Rich text"): every character kept, in order, so the text reads
 * exactly as written - only split into coloured pieces. JSON is coloured like the call card's bodies; SQL, Java / JS /
 * TS, XML / HTML and shell by their keywords, strings, numbers and comments; a diff by its added and removed lines.
 */
export type CodeTokenKind = 'key' | 'string' | 'number' | 'bool' | 'null' | 'keyword' | 'comment' | 'tag' | 'attr' | 'add' | 'del' | 'meta';

export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind | null;
}

/** The languages the board colours, by the names a fence or the editor's picker uses. */
export const CODE_LANGS: readonly { readonly id: string; readonly label: string }[] = [
  { id: '', label: 'Plain' }, { id: 'json', label: 'JSON' }, { id: 'sql', label: 'SQL' }, { id: 'java', label: 'Java' },
  { id: 'js', label: 'JS / TS' }, { id: 'xml', label: 'XML / HTML' }, { id: 'shell', label: 'Shell' }, { id: 'diff', label: 'Diff' },
  { id: 'log', label: 'Log / stack' },
];

const ALIASES: Record<string, string> = {
  javascript: 'js', typescript: 'js', ts: 'js', html: 'xml', sh: 'shell', bash: 'shell', powershell: 'shell', ps: 'shell',
  kotlin: 'java', groovy: 'java', patch: 'diff', stack: 'log', text: '', txt: '', plain: '',
};

export function langOf(lang: string | null | undefined): string {
  const l = (lang ?? '').trim().toLowerCase();
  return ALIASES[l] ?? l;
}

const SQL_KEYWORDS = 'select|from|where|and|or|not|in|is|null|as|join|left|right|inner|outer|full|on|group|by|order|having|limit|offset|insert|into|'
  + 'values|update|set|delete|create|table|index|drop|alter|add|primary|key|foreign|references|distinct|union|all|case|when|then|else|end|'
  + 'exists|between|like|asc|desc|with|returning|count|sum|avg|min|max|fetch|first|rows|only|top';
const JAVA_KEYWORDS = 'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|'
  + 'float|for|if|implements|import|instanceof|int|interface|long|new|package|private|protected|public|return|short|static|super|switch|'
  + 'synchronized|this|throw|throws|try|void|volatile|while|var|let|function|async|await|export|from|type|record|yield|of|const|undefined';
const SHELL_KEYWORDS = 'if|then|else|fi|for|do|done|while|case|esac|function|in|export|echo|cd|curl|docker|git|python|node|npm|mvn|sudo|set';

const PATTERNS: Record<string, readonly [RegExp, CodeTokenKind][]> = {
  sql: [[/--[^\n]*/y, 'comment'], [/\/\*[\s\S]*?\*\//y, 'comment'], [/'(?:[^']|'')*'/y, 'string'], [/"[^"\n]*"/y, 'key'],
    [/\b\d+(?:\.\d+)?\b/y, 'number'], [new RegExp(`\\b(?:${SQL_KEYWORDS})\\b`, 'iy'), 'keyword'], [/\?|:\w+/y, 'meta']],
  java: [[/\/\/[^\n]*/y, 'comment'], [/\/\*[\s\S]*?\*\//y, 'comment'], [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y, 'string'],
    [/@\w+/y, 'meta'], [/\b\d+(?:\.\d+)?[lLfFdD]?\b/y, 'number'], [/\b(?:true|false)\b/y, 'bool'], [/\bnull\b/y, 'null'],
    [new RegExp(`\\b(?:${JAVA_KEYWORDS})\\b`, 'y'), 'keyword']],
  xml: [[/<!--[\s\S]*?-->/y, 'comment'], [/<\/?[\w:.-]+/y, 'tag'], [/\/?>/y, 'tag'], [/[\w:.-]+(?==)/y, 'attr'], [/"[^"]*"|'[^']*'/y, 'string']],
  shell: [[/#[^\n]*/y, 'comment'], [/"(?:[^"\\]|\\.)*"|'[^']*'/y, 'string'], [/\$\{?\w+\}?/y, 'meta'], [/(?<=\s|^)--?[\w-]+/y, 'attr'],
    [new RegExp(`\\b(?:${SHELL_KEYWORDS})\\b`, 'y'), 'keyword']],
};

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;

/** Tokens of JSON - every character kept, in order. */
export function jsonCodeTokens(text: string): CodeToken[] {
  const out: CodeToken[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), kind: null });
    if (m[1]) {
      out.push({ text: m[1], kind: m[2] ? 'key' : 'string' });
      if (m[2]) out.push({ text: m[2], kind: null });
    } else {
      out.push({ text: m[0], kind: m[3] ? 'number' : m[4] ? 'bool' : 'null' });
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: null });
  return out;
}

/** The coloured pieces of a block of code, or null for a language the board does not colour. */
export function codeTokens(text: string, lang: string): CodeToken[] | null {
  const l = langOf(lang);
  if (l === 'json') return jsonCodeTokens(text);
  if (l === 'diff') return lineTokens(text, (line) => (/^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : /^(@@|\+\+\+|---|diff |index )/.test(line) ? 'meta' : null));
  if (l === 'log') return lineTokens(text, (line) => (/^\s+at\s|^\s*\.\.\.\s\d+ more/.test(line) ? 'comment' : /\b(ERROR|Exception|Error|FATAL|SEVERE)\b/.test(line) ? 'del' : /\bWARN/.test(line) ? 'meta' : null));
  const patterns = PATTERNS[l === 'js' ? 'java' : l];
  if (!patterns) return null;
  const out: CodeToken[] = [];
  let plain = '';
  let i = 0;
  outer: while (i < text.length) {
    for (const [re, kind] of patterns) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0].length) {
        if (plain) { out.push({ text: plain, kind: null }); plain = ''; }
        out.push({ text: m[0], kind });
        i += m[0].length;
        continue outer;
      }
    }
    plain += text[i++];
  }
  if (plain) out.push({ text: plain, kind: null });
  return out;
}

function lineTokens(text: string, kindOf: (line: string) => CodeTokenKind | null): CodeToken[] {
  const lines = text.split('\n');
  return lines.map((line, i) => ({ text: line + (i < lines.length - 1 ? '\n' : ''), kind: kindOf(line) }));
}

/** What a pasted text looks like, so it lands as a code block in its language (smart paste). Null: plain text. */
export function guessLang(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
  }
  if (/^(select|insert|update|delete|with|create|alter)\b[\s\S]*\b(from|into|set|table|as|values)\b/i.test(t)) return 'sql';
  if (/^<\?xml|^<([a-z][\w:.-]*)[\s>][\s\S]*<\/\1>\s*$/i.test(t)) return 'xml';
  const lines = t.split('\n');
  if (lines.length >= 2 && lines.filter((l) => /^\s+at\s+[\w$.<>]+\(/.test(l)).length >= 2) return 'log';
  if (/^(diff --git|---\s|\+\+\+\s|@@ )/m.test(t) && lines.some((l) => /^[+-]/.test(l))) return 'diff';
  return null;
}
