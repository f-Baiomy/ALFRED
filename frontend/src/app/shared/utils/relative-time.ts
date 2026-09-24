/** "just now" / "3 min ago" / "2 h ago" / "4 d ago" - a list you scan for "the one from a minute ago" reads faster this way than as ISO timestamps. Callers put the absolute time in a title. */
export function relativeTime(timestamp: string, now: number): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return timestamp;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
