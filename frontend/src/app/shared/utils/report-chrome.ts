/**
 * The parts every readable .html report shares around its content - the call exports
 * (html-builder.ts) and the Relive / scenario reports (relive-run-export.ts): a contents column that
 * folds away, and scrollbars drawn in the page's own slate colours instead of the browser's
 * light-grey default. One copy here, so the two report shells cannot drift apart.
 */

/** The button at the top of the contents column, and the one that brings it back when it is folded. */
export const TOC_TOGGLE_HTML =
  '<button type="button" class="toc-toggle" data-toc-toggle title="Hide the contents (shortcut: [)" aria-label="Hide the contents">⟨ Hide</button>';
export const TOC_OPEN_HTML =
  '<button type="button" class="toc-open" data-toc-toggle title="Show the contents (shortcut: [)" aria-label="Show the contents">☰ Contents</button>';

export const REPORT_CHROME_STYLE = `
/* ---- Scrollbars in the page's colours: thin, dark track, a soft thumb that brightens on hover. ---- */
html { scrollbar-color: rgba(255, 255, 255, 0.16) transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.16) transparent; }
*:hover { scrollbar-color: rgba(255, 255, 255, 0.28) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }
/* Nothing on the page may push it sideways - wide content scrolls inside its own box. */
body { overflow-x: clip; }

/* ---- The contents column folds away ---- */
.toc-toggle { display: block; margin: 0 0 0.4rem auto; font: inherit; font-size: 11.5px; color: var(--text-faint, #5b5b63); background: transparent; border: 1px solid var(--border, rgba(255,255,255,.09)); border-radius: 6px; padding: 2px 9px; cursor: pointer; }
.toc-toggle:hover, .toc-open:hover { color: var(--text, #f2f2f5); border-color: var(--border-strong, rgba(255,255,255,.18)); }
.toc-open { display: none; position: fixed; top: 14px; left: 14px; z-index: 20; font: inherit; font-size: 12.5px; color: var(--text-dim, #8b8b93); background: var(--card, #1b1b1d); border: 1px solid var(--border, rgba(255,255,255,.09)); border-radius: 8px; padding: 5px 12px; cursor: pointer; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
html.toc-collapsed .doc { grid-template-columns: minmax(0, 1fr); }
html.toc-collapsed .toc { display: none; }
html.toc-collapsed .toc-open { display: block; }
/* Room for the floating button above the first line of the page. */
html.toc-collapsed .doc > main { padding-top: 3.4rem; }
@media (max-width: 900px) { .toc-open { display: none !important; } }
@media print { .toc-toggle, .toc-open { display: none !important; } }
`;

/** Folds and unfolds the contents column; remembers the choice for this file (when the browser allows). */
export const REPORT_CHROME_SCRIPT = `
(function () {
  var KEY = 'alfred-report-toc:' + location.pathname;
  function setCollapsed(collapsed) {
    document.documentElement.classList.toggle('toc-collapsed', collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* storage blocked - fine */ }
  }
  try { if (localStorage.getItem(KEY) === '1') document.documentElement.classList.add('toc-collapsed'); } catch (e) { /* ignore */ }
  document.querySelectorAll('[data-toc-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () { setCollapsed(!document.documentElement.classList.contains('toc-collapsed')); });
  });
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (ev.key !== '[' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    setCollapsed(!document.documentElement.classList.contains('toc-collapsed'));
  });
})();
`;
