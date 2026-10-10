/**
 * The acceptance items of a spec file: list items directly under the first heading that contains "acceptance", up to
 * the next heading of the same or a higher level (specs/014-task-board research R13). The backend's AcceptanceItems
 * gives the same items and keys; both run vectors/acceptance-items.json. The checklist itself comes from the backend -
 * this is for previews (e.g. how many items a dropped file has).
 */
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^([-*+]|\d+[.)])\s+(.*)$/;

export function normalizeItem(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function acceptanceItems(content: string | null | undefined): string[] {
  const items: string[] = [];
  if (!content) return items;
  let level = -1;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, '');
    const heading = HEADING.exec(line.trim());
    if (heading && line.length > 0 && !/\s/.test(line[0])) {
      const depth = heading[1].length;
      if (level < 0) {
        if (heading[2].toLowerCase().includes('acceptance')) level = depth;
      } else if (depth <= level) {
        break;
      }
      continue;
    }
    if (level < 0 || !line || /\s/.test(line[0])) continue;
    const item = ITEM.exec(line);
    if (item) {
      const text = normalizeItem(item[2]);
      if (text) items.push(text);
    }
  }
  return items;
}

/** Lower-case hex SHA-256 of the normalized text - the key a mark is stored under. */
export async function itemKey(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeItem(text));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
