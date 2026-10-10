import { MENTION_TYPES, MentionRef, MentionType } from '../../core/models/board.models';

/**
 * `@[type:ref|label]` inside Markdown (specs/014-task-board contracts/mention-syntax.md). Anything that does not match
 * is plain text. The backend's MentionParser follows the same rules; both run vectors/mentions.json.
 */
export type MentionSegment = { readonly text: string } | { readonly mention: MentionRef };

export const MAX_LABEL = 200;

export function parseMentions(text: string | null | undefined): MentionSegment[] {
  const out: MentionSegment[] = [];
  if (!text) return out;
  let plain = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('@[', i)) {
      const parsed = tryParse(text, i);
      if (parsed) {
        if (plain) {
          out.push({ text: plain });
          plain = '';
        }
        out.push({ mention: parsed.ref });
        i = parsed.end;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Every mention in the text, first occurrence kept. */
export function mentionsIn(text: string | null | undefined): MentionRef[] {
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  for (const s of parseMentions(text)) {
    if ('mention' in s) {
      const key = `${s.mention.type}:${s.mention.ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(s.mention);
      }
    }
  }
  return out;
}

export function serializeMention(ref: MentionRef): string {
  const label = ref.label.replace(/[\r\n]/g, ' ').replace(/\|/g, '\\|').replace(/]/g, '\\]');
  return `@[${ref.type.toLowerCase()}:${ref.ref}|${label}]`;
}

/** Heading text to the slug a spec mention's `#section` uses. */
export function slug(heading: string): string {
  let out = '';
  let dash = false;
  for (const c of heading.toLowerCase()) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      out += c;
      dash = false;
    } else if (!dash && out) {
      out += '-';
      dash = true;
    }
  }
  return out.replace(/-+$/, '');
}

/** The call id of a call mention (`in:<id>` / `out:<id>@<cycle>`), its direction and cycle. */
export function callOf(ref: MentionRef): { direction: 'in' | 'out'; id: string; cycleId: string | null } | null {
  if (ref.type.toLowerCase() !== 'call') return null;
  const m = /^(in|out):([^@]+)(?:@(.+))?$/.exec(ref.ref);
  return m ? { direction: m[1] as 'in' | 'out', id: m[2], cycleId: m[3] ?? null } : null;
}

function tryParse(text: string, start: number): { ref: MentionRef; end: number } | null {
  const colon = text.indexOf(':', start + 2);
  if (colon < 0) return null;
  const typeName = text.slice(start + 2, colon);
  if (!(MENTION_TYPES as readonly string[]).includes(typeName)) return null;
  let pipe = -1;
  for (let i = colon + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '|') {
      pipe = i;
      break;
    }
    if (c === ']' || c === '\n' || c === '\r') return null;
  }
  if (pipe < 0 || pipe === colon + 1) return null;
  const ref = text.slice(colon + 1, pipe);
  let label = '';
  for (let i = pipe + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && (text[i + 1] === '|' || text[i + 1] === ']')) {
      label += text[i + 1];
      i++;
      continue;
    }
    if (c === '\n' || c === '\r' || c === '|') return null;
    if (c === ']') {
      if (!label || label.length > MAX_LABEL) return null;
      return { ref: { type: typeName as MentionType, ref, label }, end: i + 1 };
    }
    label += c;
  }
  return null;
}
