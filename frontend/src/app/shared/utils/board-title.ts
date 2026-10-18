/**
 * The board header's plain title (specs/032 T041): the board's name without the work item's id prefix, which the ref chip
 * already shows - "#59851_Q4-INTE-CORE-015 Baggage Bundle…" reads "Baggage Bundle…". The full name stays in the tooltip.
 */
export function plainBoardTitle(name: string | null | undefined, ref?: string | null): string {
  const full = (name ?? '').trim();
  let t = full
    .replace(/^#\d+_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*_?\s*/, '') // #59851_Q4-INTE-CORE-015 (code optional)
    .replace(/^#\d+_?\s*/, '')
    .replace(/^AB#\d+\s*[·:\-–]?\s*/i, '');
  if (ref && /^AB#\d+$/i.test(ref)) t = t.replace(new RegExp(`\\s*${ref}\\s*`, 'i'), ' ').trim();
  return t.trim() || full;
}

/** The ref chip: the main work item's "AB#<id>"; a board without one has no chip (its name is the title). */
export function boardRefChip(ref: string | null | undefined, linkedItem: string | null | undefined): string | null {
  if (ref && /^AB#\d+$/i.test(ref)) return ref;
  const id = linkedItem?.split('/').pop();
  return id && /^\d+$/.test(id) ? `AB#${id}` : null;
}
