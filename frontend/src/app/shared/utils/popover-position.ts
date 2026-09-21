/**
 * Computes fixed-position coordinates for a popover panel anchored below a trigger element.
 *
 * `position: fixed` is normally relative to the viewport - EXCEPT that any ancestor with
 * `filter`, `backdrop-filter`, `transform`, `perspective`, `contain: paint|layout|content|strict`,
 * or a `will-change` referencing one of those becomes the containing block for fixed descendants
 * instead (per the CSS Transforms spec). `header`/`.tab-nav` both set `backdrop-filter` for the
 * glass themes, so a naive "top = triggerRect.bottom" computation lands `header.getBoundingClientRect().top`
 * pixels too low whenever a popover trigger lives inside one of them and the active theme's
 * `--card-blur` is non-zero (confirmed live: correct in Dark, offset by exactly header's own
 * distance from the viewport top in Slate). Walking up for that ancestor and subtracting its own
 * offset converts the target back into "relative to whatever the browser will actually use."
 */
export function computeFixedPanelPosition(
  trigger: HTMLElement,
  options: { width: number; gap: number }
): { top: number; left: number } {
  const rect = trigger.getBoundingClientRect();
  const containingBlock = findFixedContainingBlockAncestor(trigger);
  const originTop = containingBlock ? containingBlock.getBoundingClientRect().top : 0;
  const originLeft = containingBlock ? containingBlock.getBoundingClientRect().left : 0;

  const left = Math.min(rect.left, window.innerWidth - options.width - options.gap);
  return {
    top: rect.bottom + options.gap - originTop,
    left: Math.max(options.gap, left) - originLeft,
  };
}

/**
 * Keeps a popover glued to its trigger while the page scrolls, including scrolling an ancestor
 * `overflow: auto` element (a dialog body) rather than the window - which is the common case here,
 * since most of these triggers live inside a scrollable dialog.
 *
 * `computeFixedPanelPosition` is called once, when the popover opens, and never again on its own -
 * the position is `position: fixed`, so it does not move with the page, but the TRIGGER does the
 * moment its scrollable ancestor scrolls. The panel then reads as detached from whatever it is
 * supposed to be describing, floating wherever the trigger happened to be when it opened.
 *
 * A scroll on an inner `overflow` container does not bubble to `window` or `document` at all
 * (unlike most DOM events), so `element.addEventListener('scroll', fn)` and even
 * `document.addEventListener('scroll', fn)` both miss it. Listening in the CAPTURE phase on
 * `document` is what still sees it: capture dispatches top-down before bubbling would even start,
 * so it fires regardless of whether this particular event bubbles at all.
 *
 * Returns an unsubscribe function - call it the moment the popover closes, not only on destroy,
 * or a background listener keeps recomputing a position nothing is reading.
 */
export function trackPopoverPosition(
  trigger: HTMLElement,
  options: { width: number; gap: number },
  onMove: (position: { top: number; left: number }) => void
): () => void {
  const recompute = () => onMove(computeFixedPanelPosition(trigger, options));
  document.addEventListener('scroll', recompute, true);
  window.addEventListener('resize', recompute);
  return () => {
    document.removeEventListener('scroll', recompute, true);
    window.removeEventListener('resize', recompute);
  };
}

function findFixedContainingBlockAncestor(element: HTMLElement): HTMLElement | null {
  let el = element.parentElement;
  while (el && el !== document.body) {
    if (establishesFixedContainingBlock(el)) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function establishesFixedContainingBlock(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.filter !== 'none' || style.backdropFilter !== 'none' || style.transform !== 'none') {
    return true;
  }
  if (style.perspective !== 'none') {
    return true;
  }
  if (/paint|layout|content|strict/.test(style.contain)) {
    return true;
  }
  return /transform|filter|perspective/.test(style.willChange);
}
