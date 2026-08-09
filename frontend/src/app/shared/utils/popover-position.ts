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
