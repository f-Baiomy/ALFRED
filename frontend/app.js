const BACKEND_URL = window.BACKEND_URL || "http://localhost:5000";

let allCalls = [];
let expanded = true;
const PAGE_SIZE = 20;
let visibleCount = PAGE_SIZE;
const openState = new Map(); // block id -> whether the user last left it open
const scrollState = new Map(); // pre id -> scrollTop the user last left it at
const blockSearchState = new Map(); // content div id -> { query, matches: [], index }
const blockOriginalHtml = new Map(); // content div id -> pristine (unhighlighted) innerHTML
const blockFilterMode = new Map(); // content div id -> whether "lines only" mode is on
const blockViewMode = new Map(); // content div id -> "flat" | "tree"

function isBlockOpen(id) {
  return openState.has(id) ? openState.get(id) : expanded;
}

const el = (sel) => document.querySelector(sel);
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function syntaxHighlight(value) {
  const json = escapeHtml(JSON.stringify(value, null, 2));
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "n";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "k" : "s";
      } else if (/true|false/.test(match)) {
        cls = "b";
      } else if (/null/.test(match)) {
        cls = "z";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function tryParseJson(text) {
  if (typeof text !== "string") return { ok: false };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function renderTreeLeaf(value) {
  if (value === null) return `<span class="z">null</span>`;
  if (typeof value === "boolean") return `<span class="b">${value}</span>`;
  if (typeof value === "number") return `<span class="n">${value}</span>`;
  if (typeof value === "string") return `<span class="s">${escapeHtml(JSON.stringify(value))}</span>`;
  return escapeHtml(String(value));
}

// Renders a list of {key, value} entries as collapsible tree rows. `key` is
// null for array items and the implicit root wrapper (renderTree below).
function renderTreeEntries(entries) {
  return entries
    .map(({ key, value }, i) => {
      const comma = i < entries.length - 1 ? `<span class="punct">,</span>` : "";
      const keyHtml = key !== null ? `<span class="k">${escapeHtml(JSON.stringify(String(key)))}</span><span class="punct">: </span>` : "";

      if (value !== null && typeof value === "object") {
        const isArray = Array.isArray(value);
        const childEntries = isArray
          ? value.map((v) => ({ key: null, value: v }))
          : Object.entries(value).map(([k, v]) => ({ key: k, value: v }));
        const openBrace = isArray ? "[" : "{";
        const closeBrace = isArray ? "]" : "}";

        if (childEntries.length === 0) {
          return `<div class="tree-row">${keyHtml}<span class="punct">${openBrace}${closeBrace}</span>${comma}</div>`;
        }

        const count = childEntries.length;
        const noun = isArray ? "item" : "key";
        return `
          <details class="tree-node" open>
            <summary>${keyHtml}<span class="punct">${openBrace}</span><span class="tree-count">${count} ${noun}${count === 1 ? "" : "s"}</span></summary>
            <div class="tree-body">${renderTreeEntries(childEntries)}</div>
            <div class="tree-close"><span class="punct">${closeBrace}</span>${comma}</div>
          </details>`;
      }

      return `<div class="tree-row">${keyHtml}${renderTreeLeaf(value)}${comma}</div>`;
    })
    .join("");
}

function renderTree(rootValue) {
  if (rootValue !== null && typeof rootValue === "object") {
    return renderTreeEntries([{ key: null, value: rootValue }]);
  }
  return `<div class="tree-row">${renderTreeLeaf(rootValue)}</div>`;
}

function renderJsonBlock(id, label, value, rawTextFallback) {
  let jsonValue;
  let plainText;
  if (value !== undefined && value !== null && typeof value === "object") {
    jsonValue = value;
  } else if (typeof rawTextFallback === "string" && rawTextFallback.length) {
    const parsed = tryParseJson(rawTextFallback);
    if (parsed.ok) {
      jsonValue = parsed.value;
    } else {
      plainText = rawTextFallback;
    }
  }

  const hasJson = jsonValue !== undefined;
  const mode = hasJson ? blockViewMode.get(id) || "flat" : "flat";
  const scrollId = `${id}-pre`;

  let inner;
  if (mode === "tree") {
    inner = `<div id="${scrollId}" class="scrollable json-tree">${renderTree(jsonValue)}</div>`;
  } else if (hasJson) {
    inner = `<pre id="${scrollId}" class="scrollable json">${syntaxHighlight(jsonValue)}</pre>`;
  } else if (plainText !== undefined) {
    inner = `<pre id="${scrollId}" class="scrollable plain">${escapeHtml(plainText)}</pre>`;
  } else {
    inner = `<pre id="${scrollId}" class="scrollable plain">(empty)</pre>`;
  }

  const savedQuery = blockSearchState.get(id)?.query || "";
  const filterOn = blockFilterMode.get(id) || false;

  const viewTabs = hasJson
    ? `
          <div class="block-view-tabs">
            <button class="block-view-tab${mode === "flat" ? " active" : ""}" data-target="${id}" data-mode="flat">Flat</button>
            <button class="block-view-tab${mode === "tree" ? " active" : ""}" data-target="${id}" data-mode="tree">Tree</button>
          </div>`
    : "";

  const filterToggle =
    mode === "flat"
      ? `
          <button
            class="block-search-mode${filterOn ? " active" : ""}"
            id="${id}-mode"
            data-target="${id}"
            title="Toggle: show only matching lines"
            aria-pressed="${filterOn}"
          >Lines only</button>`
      : "";

  return `
    <details class="block" id="${id}-details"${isBlockOpen(`${id}-details`) ? " open" : ""}>
      <summary>${label}</summary>
      <div class="json-wrap">
        <div class="block-toolbar">
          ${viewTabs}
          <input
            type="text"
            class="block-search"
            id="${id}-search"
            placeholder="Find in block..."
            value="${escapeHtml(savedQuery)}"
          />
          <span class="block-search-count" id="${id}-search-count"></span>
          <button class="block-search-nav" data-dir="-1" data-target="${id}" title="Previous match">&lsaquo;</button>
          <button class="block-search-nav" data-dir="1" data-target="${id}" title="Next match">&rsaquo;</button>
          ${filterToggle}
          <button class="copy-btn" data-copy-target="${id}">Copy</button>
        </div>
        <div id="${id}">${inner}</div>
      </div>
    </details>`;
}

function clearBlockHighlights(blockId) {
  const container = document.getElementById(blockId);
  const pristine = blockOriginalHtml.get(blockId);
  if (container && pristine !== undefined) {
    container.innerHTML = pristine;
  }
}

function updateBlockSearchCount(blockId) {
  const countEl = document.getElementById(`${blockId}-search-count`);
  if (!countEl) return;
  const state = blockSearchState.get(blockId);
  if (!state || !state.query) {
    countEl.textContent = "";
  } else {
    countEl.textContent = state.matches.length ? `${state.index + 1}/${state.matches.length}` : "0/0";
  }
}

function setActiveBlockMatch(blockId, newIndex) {
  const state = blockSearchState.get(blockId);
  if (!state || !state.matches.length) return;
  const len = state.matches.length;
  const idx = ((newIndex % len) + len) % len;

  state.matches.forEach((m) => m.classList.remove("active"));
  const mark = state.matches[idx];
  mark.classList.add("active");
  state.index = idx;
  updateBlockSearchCount(blockId);

  const details = document.getElementById(`${blockId}-details`);
  if (details && !details.open) {
    details.open = true;
    openState.set(details.id, true);
  }

  const scrollRoot = mark.closest(".scrollable");
  if (scrollRoot) {
    const target = mark.offsetTop - scrollRoot.clientHeight / 2 + mark.offsetHeight / 2;
    scrollRoot.scrollTop = Math.max(0, target);
    scrollState.set(scrollRoot.id, scrollRoot.scrollTop);
  }
}

// Wraps every occurrence of `q` inside root's text nodes in <mark class="hl">,
// without disturbing existing syntax-highlight <span> elements. Works on
// either a flat <pre> or a tree <div> root. Returns the marks in document order.
function highlightMatchesInRoot(root, q) {
  const matches = [];
  if (!root) return matches;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach((textNode) => {
    const text = textNode.nodeValue;
    const lower = text.toLowerCase();
    if (!lower.includes(q)) return;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let idx;
    while ((idx = lower.indexOf(q, lastIndex)) !== -1) {
      if (idx > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      matches.push(mark);
      lastIndex = idx + q.length;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.parentNode.replaceChild(frag, textNode);
  });

  return matches;
}

function setHiddenLinesNote(blockId, text) {
  const container = document.getElementById(blockId);
  if (!container) return;
  let note = document.getElementById(`${blockId}-hidden-note`);
  if (!text) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.id = `${blockId}-hidden-note`;
    note.className = "hidden-lines-note";
    container.appendChild(note);
  }
  note.textContent = text;
}

// "Lines only" mode: keep just the lines whose visible text contains the
// query, then highlight matches within what's left. Operates on the
// pristine pre's innerHTML split on "\n" - safe because the pretty-printer's
// only newlines are structural (JSON string values never contain a raw
// newline, only the escaped "\n").
function applyLineFilter(container, blockId, q) {
  const pre = container.querySelector("pre");
  if (!pre) {
    blockSearchState.set(blockId, { query: q, matches: [], index: -1 });
    return;
  }

  const lines = pre.innerHTML.split("\n");
  const keptLines = lines.filter((line) => line.replace(/<[^>]+>/g, "").toLowerCase().includes(q));
  const hiddenCount = lines.length - keptLines.length;

  pre.innerHTML = keptLines.join("\n");
  const matches = highlightMatchesInRoot(pre, q);

  blockSearchState.set(blockId, { query: q, matches, index: matches.length ? 0 : -1 });

  if (keptLines.length === 0) {
    setHiddenLinesNote(blockId, `No lines match - ${hiddenCount} hidden`);
  } else if (hiddenCount > 0) {
    setHiddenLinesNote(blockId, `${hiddenCount} of ${lines.length} lines hidden`);
  } else {
    setHiddenLinesNote(blockId, "");
  }
}

function applyBlockSearch(blockId, query) {
  const container = document.getElementById(blockId);
  if (!container) return;

  clearBlockHighlights(blockId);
  setHiddenLinesNote(blockId, "");

  if (!query) {
    blockSearchState.delete(blockId);
    updateBlockSearchCount(blockId);
    return;
  }

  const q = query.toLowerCase();

  if (blockFilterMode.get(blockId) && container.querySelector("pre")) {
    applyLineFilter(container, blockId, q);
  } else {
    const matches = highlightMatchesInRoot(container.querySelector(".scrollable"), q);
    blockSearchState.set(blockId, { query, matches, index: matches.length ? 0 : -1 });
  }

  updateBlockSearchCount(blockId);
  const state = blockSearchState.get(blockId);
  if (state.matches.length) {
    setActiveBlockMatch(blockId, 0);
  }
}

function restoreBlockSearches(container) {
  container.querySelectorAll(".json-wrap > div[id]").forEach((div) => {
    blockOriginalHtml.set(div.id, div.innerHTML);
  });
  blockSearchState.forEach((state, blockId) => {
    if (!state.query) return;
    applyBlockSearch(blockId, state.query);
  });
}

function durationClass(ms) {
  if (ms == null) return "";
  if (ms < 300) return "fast";
  if (ms < 1200) return "mid";
  return "slow";
}

function statusClass(status) {
  if (status == null) return "status-err";
  if (status >= 500) return "status-5xx";
  if (status >= 400) return "status-4xx";
  if (status >= 300) return "status-3xx";
  return "status-2xx";
}

function methodClass(method) {
  const m = (method || "").toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)
    ? `method-${m}`
    : "method-DEFAULT";
}

function callKey(c) {
  // Stable across re-renders even when new calls shift list indices -
  // deliberately NOT index-based, since the list is prepended to.
  const raw = `${c.timestamp || ""}|${c.method || ""}|${c.original_url || ""}`;
  return "c_" + raw.replace(/[^a-zA-Z0-9]/g, "_");
}

const callDataById = new Map(); // call id -> the call object, for cURL/download actions

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function buildCurlCommand(c) {
  const method = (c.method || "GET").toUpperCase();
  const url = c.url || c.original_url || "";
  const parts = [`curl -X ${method} ${shQuote(url)}`];

  Object.entries(c.request?.headers || {}).forEach(([k, v]) => {
    parts.push(`-H ${shQuote(`${k}: ${v}`)}`);
  });

  if (c.request?.body) {
    parts.push(`--data-raw ${shQuote(c.request.body)}`);
  }

  return parts.join(" \\\n  ");
}

function downloadCallJson(c, id) {
  const blob = new Blob([JSON.stringify(c, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function flashButtonText(btn, text, ms = 1200) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), ms);
}

function renderCall(c) {
  const method = c.method || "?";
  const status = c.response ? c.response.status : null;
  const duration = c.duration_ms;
  const ts = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
  const idBase = callKey(c);
  callDataById.set(idBase, c);

  const errorBanner = c.error
    ? `<div class="error-banner">⚠ ${escapeHtml(c.error)}</div>`
    : "";

  const statusBadge = c.error
    ? `<span class="badge status-err">ERROR</span>`
    : `<span class="badge ${statusClass(status)}">${status ?? "?"}</span>`;

  const requestPanel = `
    <div class="panel">
      <div class="panel-title">Request</div>
      ${renderJsonBlock(`${idBase}-req-headers`, "Headers", c.request?.headers)}
      ${renderJsonBlock(`${idBase}-req-body`, "Body", undefined, c.request?.body)}
    </div>`;

  const responsePanel = c.response
    ? `
    <div class="panel">
      <div class="panel-title">Response</div>
      ${renderJsonBlock(`${idBase}-res-headers`, "Headers", c.response?.headers)}
      ${renderJsonBlock(`${idBase}-res-body`, "Body", undefined, c.response?.body)}
    </div>`
    : "";

  return `
    <div class="call">
      <div class="call-top">
        <span class="badge ${methodClass(method)}">${escapeHtml(method)}</span>
        ${statusBadge}
        ${duration != null ? `<span class="duration ${durationClass(duration)}">${duration} ms</span>` : ""}
        <div class="call-actions">
          <button class="action-btn" data-action="curl" data-call-id="${idBase}" title="Copy as cURL">cURL</button>
          <button class="action-btn" data-action="download" data-call-id="${idBase}" title="Download raw call as JSON">JSON &darr;</button>
        </div>
        <span class="call-time">${ts}</span>
      </div>
      <div class="call-urls">
        <div class="uri-row">
          <span class="uri-label from">From</span>
          <span class="uri-value from">${escapeHtml(c.original_url || "")}</span>
        </div>
        <div class="uri-row">
          <span class="uri-label to">To</span>
          <span class="uri-value to">${escapeHtml(c.url || "")}</span>
        </div>
      </div>
      ${errorBanner}
      <div class="panels">
        ${requestPanel}
        ${responsePanel}
      </div>
    </div>`;
}

function renderStats(calls) {
  const total = calls.length;
  const ok = calls.filter(c => c.response && c.response.status < 400).length;
  const client = calls.filter(c => c.response && c.response.status >= 400 && c.response.status < 500).length;
  const failed = calls.filter(c => c.error || (c.response && c.response.status >= 500)).length;

  el("#stats").innerHTML = `
    <span class="stat-pill"><b>${total}</b> calls</span>
    <span class="stat-pill ok"><b>${ok}</b> 2xx/3xx</span>
    <span class="stat-pill warn"><b>${client}</b> 4xx</span>
    <span class="stat-pill err"><b>${failed}</b> errors/5xx</span>
  `;
}

function matchesFilter(c, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const parts = [
    c.method, c.original_url, c.url,
    c.response ? String(c.response.status) : "",
    c.error || ""
  ];
  if (c.request) {
    parts.push(JSON.stringify(c.request.headers || {}));
    parts.push(c.request.body || "");
  }
  if (c.response) {
    parts.push(JSON.stringify(c.response.headers || {}));
    parts.push(c.response.body || "");
  }
  const haystack = parts.join(" ").toLowerCase();
  return haystack.includes(q);
}

function restoreScrollPositions(container) {
  container.querySelectorAll(".scrollable[id]").forEach(root => {
    if (scrollState.has(root.id)) {
      root.scrollTop = scrollState.get(root.id);
    }
  });
}

function statusRank(c) {
  if (c.error) return 999;
  return c.response?.status ?? -1;
}

function sortCalls(calls, mode) {
  const arr = [...calls];
  switch (mode) {
    case "oldest":
      // allCalls arrives newest-first from the backend.
      return arr.reverse();
    case "slowest":
      return arr.sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1));
    case "fastest":
      return arr.sort((a, b) => (a.duration_ms ?? Infinity) - (b.duration_ms ?? Infinity));
    case "status":
      return arr.sort((a, b) => statusRank(b) - statusRank(a));
    default:
      return arr;
  }
}

function renderAll() {
  const query = el("#search").value.trim();
  const sortMode = el("#sort").value;
  const filtered = sortCalls(allCalls.filter(c => matchesFilter(c, query)), sortMode);
  renderStats(filtered);

  const container = el("#calls");
  if (allCalls.length === 0) {
    container.innerHTML = `<div class="empty">No calls logged yet — waiting for traffic through Alfred.</div>`;
    return;
  }
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty">No calls match "${escapeHtml(query)}".</div>`;
    return;
  }

  visibleCount = Math.max(PAGE_SIZE, Math.min(visibleCount, filtered.length));
  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  const loadMoreHtml = remaining > 0
    ? `<button class="load-more-btn" id="loadMoreBtn">Load ${Math.min(PAGE_SIZE, remaining)} more (showing ${visible.length} of ${filtered.length})</button>`
    : filtered.length > PAGE_SIZE
      ? `<div class="all-shown-note">Showing all ${filtered.length} matching calls</div>`
      : "";

  container.innerHTML = visible.map(renderCall).join("") + loadMoreHtml;
  restoreScrollPositions(container);
  restoreBlockSearches(container);
}

async function loadCalls() {
  const limit = el("#limit").value;
  try {
    const res = await fetch(`${BACKEND_URL}/calls?limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allCalls = await res.json();
    renderAll();
  } catch (err) {
    el("#calls").innerHTML = `<div class="error-box">Could not reach backend at ${escapeHtml(BACKEND_URL)}: ${escapeHtml(String(err))}</div>`;
  }
}

document.addEventListener("click", (e) => {
  const actionBtn = e.target.closest(".action-btn");
  if (actionBtn) {
    const c = callDataById.get(actionBtn.dataset.callId);
    if (!c) return;
    if (actionBtn.dataset.action === "curl") {
      navigator.clipboard.writeText(buildCurlCommand(c)).then(() => flashButtonText(actionBtn, "Copied!"));
    } else if (actionBtn.dataset.action === "download") {
      downloadCallJson(c, actionBtn.dataset.callId);
    }
    return;
  }

  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const target = document.getElementById(btn.dataset.copyTarget);
  if (!target) return;
  navigator.clipboard.writeText(target.innerText).then(() => flashButtonText(btn, "Copied!"));
});

// "toggle" does not bubble, so listen on the container in the capture
// phase - this is what remembers a manually expanded/collapsed block
// across the next auto-refresh re-render.
el("#calls").addEventListener(
  "toggle",
  (e) => {
    const details = e.target;
    if (details.classList && details.classList.contains("block")) {
      openState.set(details.id, details.open);
    }
  },
  true
);

// "scroll" is likewise captured on the container rather than relying on
// bubbling, so a scroll position inside any JSON block (flat or tree)
// survives the next auto-refresh re-render instead of jumping back to the top.
el("#calls").addEventListener(
  "scroll",
  (e) => {
    const root = e.target.closest && e.target.closest(".scrollable[id]");
    if (root) {
      scrollState.set(root.id, root.scrollTop);
    }
  },
  true
);

el("#calls").addEventListener("input", (e) => {
  const input = e.target.closest(".block-search");
  if (!input) return;
  const blockId = input.id.replace(/-search$/, "");
  applyBlockSearch(blockId, input.value.trim());
});

el("#calls").addEventListener("click", (e) => {
  if (e.target.closest("#loadMoreBtn")) {
    visibleCount += PAGE_SIZE;
    renderAll();
    return;
  }

  const viewTab = e.target.closest(".block-view-tab");
  if (viewTab) {
    const blockId = viewTab.dataset.target;
    const newMode = viewTab.dataset.mode;
    if (blockViewMode.get(blockId) !== newMode) {
      blockViewMode.set(blockId, newMode);
      renderAll();
    }
    return;
  }

  const modeBtn = e.target.closest(".block-search-mode");
  if (modeBtn) {
    const blockId = modeBtn.dataset.target;
    const nowOn = !blockFilterMode.get(blockId);
    blockFilterMode.set(blockId, nowOn);
    modeBtn.classList.toggle("active", nowOn);
    modeBtn.setAttribute("aria-pressed", String(nowOn));
    const query = document.getElementById(`${blockId}-search`)?.value.trim() || "";
    applyBlockSearch(blockId, query);
    return;
  }

  const btn = e.target.closest(".block-search-nav");
  if (!btn) return;
  const blockId = btn.dataset.target;
  const state = blockSearchState.get(blockId);
  if (!state || !state.matches.length) return;
  setActiveBlockMatch(blockId, state.index + parseInt(btn.dataset.dir, 10));
});

el("#calls").addEventListener("keydown", (e) => {
  if (!e.target.classList || !e.target.classList.contains("block-search")) return;
  if (e.key !== "Enter") return;
  e.preventDefault();
  const blockId = e.target.id.replace(/-search$/, "");
  const state = blockSearchState.get(blockId);
  if (!state || !state.matches.length) return;
  setActiveBlockMatch(blockId, state.index + (e.shiftKey ? -1 : 1));
});

el("#search").addEventListener("input", () => {
  visibleCount = PAGE_SIZE;
  renderAll();
});
el("#limit").addEventListener("change", () => {
  visibleCount = PAGE_SIZE;
  loadCalls();
});
el("#sort").addEventListener("change", () => {
  visibleCount = PAGE_SIZE;
  renderAll();
});
el("#refreshBtn").addEventListener("click", loadCalls);
el("#toggleAllBtn").addEventListener("click", () => {
  expanded = !expanded;
  el("#toggleAllBtn").textContent = expanded ? "Collapse all" : "Expand all";
  document.querySelectorAll("details.block").forEach(d => {
    d.open = expanded;
    openState.set(d.id, expanded);
  });
});

loadCalls();
setInterval(loadCalls, 5000);
