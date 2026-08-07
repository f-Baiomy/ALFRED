const BACKEND_URL = window.BACKEND_URL || "http://localhost:5000";

let allCalls = [];
let expanded = true;
const openState = new Map(); // block id -> whether the user last left it open
const scrollState = new Map(); // pre id -> scrollTop the user last left it at
const blockSearchState = new Map(); // content div id -> { query, matches: [], index }
const blockOriginalHtml = new Map(); // content div id -> pristine (unhighlighted) innerHTML
const blockFilterMode = new Map(); // content div id -> whether "lines only" mode is on

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

function renderJsonBlock(id, label, value, rawTextFallback) {
  let inner;
  if (value !== undefined && value !== null && typeof value === "object") {
    inner = `<pre class="json">${syntaxHighlight(value)}</pre>`;
  } else if (typeof rawTextFallback === "string" && rawTextFallback.length) {
    const parsed = tryParseJson(rawTextFallback);
    inner = parsed.ok
      ? `<pre class="json">${syntaxHighlight(parsed.value)}</pre>`
      : `<pre class="plain">${escapeHtml(rawTextFallback)}</pre>`;
  } else {
    inner = `<pre class="plain">(empty)</pre>`;
  }
  const preId = `${id}-pre`;
  inner = inner.replace(/^<pre class="(json|plain)">/, `<pre id="${preId}" class="$1">`);

  const savedQuery = blockSearchState.get(id)?.query || "";
  const filterOn = blockFilterMode.get(id) || false;

  return `
    <details class="block" id="${id}-details"${isBlockOpen(`${id}-details`) ? " open" : ""}>
      <summary>${label}</summary>
      <div class="json-wrap">
        <div class="block-toolbar">
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
          <button
            class="block-search-mode${filterOn ? " active" : ""}"
            id="${id}-mode"
            data-target="${id}"
            title="Toggle: show only matching lines"
            aria-pressed="${filterOn}"
          >Lines only</button>
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

  const pre = mark.closest("pre");
  if (pre) {
    const target = mark.offsetTop - pre.clientHeight / 2 + mark.offsetHeight / 2;
    pre.scrollTop = Math.max(0, target);
    scrollState.set(pre.id, pre.scrollTop);
  }
}

// Wraps every occurrence of `q` inside pre's text nodes in <mark class="hl">,
// without disturbing existing syntax-highlight <span> elements. Returns the
// marks in document order.
function highlightMatchesInPre(pre, q) {
  const matches = [];
  if (!pre) return matches;

  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
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
  const matches = highlightMatchesInPre(pre, q);

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

  if (blockFilterMode.get(blockId)) {
    applyLineFilter(container, blockId, q);
  } else {
    const matches = highlightMatchesInPre(container.querySelector("pre"), q);
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

function renderCall(c) {
  const method = c.method || "?";
  const status = c.response ? c.response.status : null;
  const duration = c.duration_ms;
  const ts = c.timestamp ? new Date(c.timestamp).toLocaleString() : "";
  const idBase = callKey(c);

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
  container.querySelectorAll("pre[id]").forEach(pre => {
    if (scrollState.has(pre.id)) {
      pre.scrollTop = scrollState.get(pre.id);
    }
  });
}

function renderAll() {
  const query = el("#search").value.trim();
  const filtered = allCalls.filter(c => matchesFilter(c, query));
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
  container.innerHTML = filtered.map(renderCall).join("");
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
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const target = document.getElementById(btn.dataset.copyTarget);
  if (!target) return;
  navigator.clipboard.writeText(target.innerText).then(() => {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1200);
  });
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
// bubbling, so a scroll position inside any JSON <pre> survives the next
// auto-refresh re-render instead of jumping back to the top.
el("#calls").addEventListener(
  "scroll",
  (e) => {
    const pre = e.target.closest && e.target.closest("pre[id]");
    if (pre) {
      scrollState.set(pre.id, pre.scrollTop);
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

el("#search").addEventListener("input", renderAll);
el("#limit").addEventListener("change", loadCalls);
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
