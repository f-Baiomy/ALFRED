import { ChatMessage, ChatNeedsYou } from '../../core/models/chat.models';

/**
 * The board chat's small pure rules (specs/022): where a waiting message is in line, the ticks under it, how many
 * messages came since the user last looked, and the bar's time and "needs you" line. Kept here so the panel, the bar and
 * the window page say the same thing.
 */

/** Waiting messages of a chat in the order Claude takes them: urgent first, then oldest first. */
export function waitingOrder(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => (m.author === 'USER' || m.kind === 'TASK') && m.state === 'WAITING')
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.id - b.id);
}

/**
 * 1-based place of a waiting message in line, counting what Claude is busy with first (a message being answered, a
 * card run of the same runner); null when it is not waiting.
 */
export function queuePosition(messages: readonly ChatMessage[], id: number, busy = 0): number | null {
  const order = waitingOrder(messages);
  const i = order.findIndex((m) => m.id === id);
  if (i < 0) return null;
  const answering = messages.some((m) => m.state === 'TAKEN') ? 1 : 0;
  return i + 1 + Math.max(answering, busy);
}

export function nth(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${s}`;
}

export interface Ticks {
  readonly marks: string;
  readonly text: string;
  readonly tone: 'sent' | 'got' | 'done' | 'off';
}

/** ✓ sent · ✓✓ Claude has it · ✓✓ answered (green) · cancelled / stopped. */
export function ticksOf(m: ChatMessage, claudeOn: boolean): Ticks | null {
  if (m.author !== 'USER') return null;
  switch (m.state) {
    case 'WAITING': return { marks: '✓', text: claudeOn ? 'sent' : 'sent · waiting for Claude', tone: 'sent' };
    case 'TAKEN': return { marks: '✓✓', text: 'Claude has it', tone: 'got' };
    case 'ANSWERED': return { marks: '✓✓', text: 'answered', tone: 'done' };
    case 'STOPPED': return { marks: '■', text: 'stopped', tone: 'off' };
    case 'CANCELLED': return { marks: '✕', text: 'cancelled', tone: 'off' };
    default: return null;
  }
}

/** Messages of others after what the user last saw - the unread count and the "— N new —" line goes above the first. */
export function unreadOf(messages: readonly ChatMessage[], lastSeenId: number): { count: number; firstId: number | null } {
  const fresh = messages.filter((m) => m.id > lastSeenId && m.author !== 'USER' && m.kind !== 'TASK');
  return { count: fresh.length, firstId: fresh.length ? fresh[0].id : null };
}

/** "2 questions · 1 proposal" for the bar's Needs you line; empty when nothing waits on the user. */
export function needsYouLine(n: ChatNeedsYou): string {
  const parts: string[] = [];
  if (n.questions) parts.push(`${n.questions} question${n.questions === 1 ? '' : 's'}`);
  if (n.proposals) parts.push(`${n.proposals} proposal${n.proposals === 1 ? '' : 's'}`);
  if (n.confirms) parts.push(`${n.confirms} to confirm`);
  return parts.join(' · ');
}

/** The bar's time: "14:05" today, "Mon" this week, else "12 Oct". */
export function barTime(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The day line between messages ("Today", "Yesterday", "12 Oct"), or null when it is the same day as the one before. */
export function dayLine(iso: string, before: string | null, now = new Date()): string | null {
  const d = new Date(iso);
  if (before && new Date(before).toDateString() === d.toDateString()) return null;
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Two letters for a chat's avatar: "PR" for the project, the cycle name's first letters otherwise. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/** Messages since the last summary, for the header's "n/100" counter. */
export function sinceSummary(messages: readonly ChatMessage[]): number {
  let last = -1;
  messages.forEach((m, i) => { if (m.kind === 'SUMMARY') last = i; });
  return messages.slice(last + 1).filter((m) => m.kind === 'TEXT' || m.kind === 'DIGEST').length;
}

/** A thread's replies by parent id, and the top-level messages in order. */
export function threadsOf(messages: readonly ChatMessage[]): { top: ChatMessage[]; replies: ReadonlyMap<number, ChatMessage[]> } {
  const ids = new Set(messages.map((m) => m.id));
  const replies = new Map<number, ChatMessage[]>();
  const top: ChatMessage[] = [];
  for (const m of messages) {
    if (m.parentId != null && ids.has(m.parentId)) replies.set(m.parentId, [...(replies.get(m.parentId) ?? []), m]);
    else top.push(m);
  }
  return { top, replies };
}

/** Compact token count: 1.2k, 34k, 1.4M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
