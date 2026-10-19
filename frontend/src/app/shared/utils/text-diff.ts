/**
 * A word diff of two short texts (specs/034): what the user changed in Claude's draft, or what Claude changed in a
 * redraft. Words and the spaces between them are tokens; runs of the same kind are merged. Meant for comments - a few
 * thousand words at most; past that it says the whole text was replaced rather than spend seconds on it.
 */
export interface DiffPart {
  readonly kind: 'same' | 'ins' | 'del';
  readonly text: string;
}

const MAX_TOKENS = 4000;

export function textDiff(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_TOKENS * MAX_TOKENS / 4) {
    return merge([...(before ? [{ kind: 'del' as const, text: before }] : []), ...(after ? [{ kind: 'ins' as const, text: after }] : [])]);
  }
  // longest common subsequence, then walk it
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'ins', text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'ins', text: b[j++] });
  return merge(out);
}

/** Whether a diff changed anything. */
export function changedText(parts: readonly DiffPart[]): boolean {
  return parts.some((p) => p.kind !== 'same');
}

function tokens(s: string): string[] {
  return s ? s.match(/\s+|[^\s]+/g) ?? [] : [];
}

function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) out[out.length - 1] = { kind: p.kind, text: last.text + p.text };
    else out.push(p);
  }
  // a lone space between two changes reads better inside them than as an unchanged island
  for (let k = 1; k < out.length - 1; k++) {
    if (out[k].kind === 'same' && /^\s+$/.test(out[k].text) && out[k - 1].kind !== 'same' && out[k + 1].kind !== 'same') {
      out[k] = { kind: 'del', text: out[k].text };
      out.splice(k + 1, 0, { kind: 'ins', text: out[k].text });
      return merge(out.filter((p) => p.text));
    }
  }
  return out;
}
