/** How long the arrow keeps nudging before it settles - matches call-reveal-nudge in styles.scss. */
const SETTLE_MS = 2600;

/**
 * Points at one call in a list that still shows every call - the cycle page's side of the cycle
 * widget's "Show in cycle". Scrolls `row` to the middle, puts a "This call" tag above it and pulses
 * its outline; afterwards a quiet outline stays until the user clicks or presses a key anywhere, so
 * it doesn't vanish while they're still finding their place.
 *
 * `row` is whatever element stands for the call: the flat list's `#call-row-<id>` wrapper, a nested
 * card, or a waterfall row (`[data-call-row]`). The tag is a child of it, positioned above it, so
 * nothing is inserted between Angular's own nodes.
 */
export function pointAtCall(row: HTMLElement): void {
  const doc = row.ownerDocument;
  doc.querySelectorAll('.call-reveal').forEach((el) => clearReveal(el as HTMLElement));

  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('call-reveal');
  const tag = doc.createElement('span');
  tag.className = 'call-reveal-tag';
  tag.setAttribute('aria-hidden', 'true');
  tag.textContent = 'This call';
  row.prepend(tag);

  // Not on the very first input: the click that brought the user here (or a scroll) shouldn't clear it.
  setTimeout(() => {
    const clear = () => clearReveal(row);
    doc.addEventListener('pointerdown', clear, { once: true, capture: true });
    doc.addEventListener('keydown', clear, { once: true, capture: true });
  }, SETTLE_MS);
}

function clearReveal(row: HTMLElement): void {
  row.classList.remove('call-reveal');
  row.querySelectorAll(':scope > .call-reveal-tag').forEach((tag) => tag.remove());
}

/** The element standing for `callId` in whichever view the list is in - see pointAtCall. */
export function findCallRow(root: ParentNode, callId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(callId) : callId.replace(/"/g, '\\"');
  return root.querySelector<HTMLElement>(`[data-call-row="${escaped}"]`) ?? root.querySelector<HTMLElement>(`#call-row-${escaped}`);
}
