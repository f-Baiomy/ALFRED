import { RuleAction } from '../../core/models/interception.model';

export interface ReplacePreview {
  /** The body as the proxy would send it - null when it would leave the body untouched (no match, bad pattern, empty body). */
  readonly text: string | null;
  readonly count: number;
  /** Why nothing changed, in the proxy's own words ("no match", "empty body", "invalid regex: …"). */
  readonly reason: string | null;
}

/**
 * What REPLACE_IN_REQUEST_BODY / REPLACE_IN_RESPONSE_BODY would do to `text`, mirroring
 * proxy/interception.py's _Pattern.replace: literal unless `regex`, case-sensitive unless
 * `caseSensitive === false`, at most `maxReplacements` (all when unset), and in regex mode a
 * Python replacement template (`\1`, `\g<name>`) - translated to the browser's `$1` / `$<name>`.
 *
 * A preview only: the browser's regex engine is not Python's `re`, so an exotic pattern can differ.
 * Common patterns - classes, groups, alternation, anchors, lazy quantifiers - behave the same.
 */
export function previewBodyReplace(text: string, action: RuleAction): ReplacePreview {
  const pattern = action.pattern ?? '';
  const replacement = action.replacement ?? '';
  const regex = action.regex === true;
  const caseSensitive = action.caseSensitive !== false;
  const max = action.maxReplacements && action.maxReplacements > 0 ? action.maxReplacements : null;
  if (!pattern) return { text: null, count: 0, reason: 'no pattern' };
  if (!text) return { text: null, count: 0, reason: 'empty body' };

  let matcher: RegExp;
  try {
    matcher = new RegExp(regex ? pattern : escapeRegExp(pattern), caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { text: null, count: 0, reason: `invalid regex: ${(e as Error).message}` };
  }
  const template = regex ? pythonTemplateToJs(replacement) : null;
  let count = 0;
  let out = '';
  let last = 0;
  for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
    if (m[0] === '') {
      matcher.lastIndex++;
      continue;
    }
    if (max !== null && count >= max) break;
    out += text.slice(last, m.index) + (template === null ? replacement : expand(template, m));
    last = m.index + m[0].length;
    count++;
  }
  out += text.slice(last);
  return count ? { text: out, count, reason: null } : { text: null, count: 0, reason: 'no match' };
}

/** `$1` / `$<name>` / `$$` against one match - expanded by hand so anchors and lookbehinds see the whole text, not the fragment. */
function expand(template: string, m: RegExpExecArray): string {
  return template.replace(/\$(\$|<(\w+)>|(\d+))/g, (_all, token: string, name?: string, num?: string) => {
    if (token === '$') return '$';
    if (name !== undefined) return m.groups?.[name] ?? '';
    return m[Number(num)] ?? '';
  });
}

/** Python `re.sub` template → JavaScript replacement string: `\1`/`\g<1>`/`\g<name>` become `$1`/`$<name>`, a literal `$` is escaped. */
export function pythonTemplateToJs(template: string): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '$') {
      out += '$$';
    } else if (c === '\\' && i + 1 < template.length) {
      const next = template[i + 1];
      const named = /^g<(\w+)>/.exec(template.slice(i + 1));
      if (named) {
        out += /^\d+$/.test(named[1]) ? `$${named[1]}` : `$<${named[1]}>`;
        i += named[0].length;
      } else if (/\d/.test(next)) {
        out += `$${next}`;
        i++;
      } else if (next === 'n') {
        out += '\n';
        i++;
      } else if (next === 't') {
        out += '\t';
        i++;
      } else if (next === '\\') {
        out += '\\';
        i++;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
