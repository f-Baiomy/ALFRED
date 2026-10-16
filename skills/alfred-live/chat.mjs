// The board chat lane of /alfred-live (specs/022, docs/board.md "Chat"). A cycle's chat is answered by the cycle's own
// Claude session: the first answer forks the terminal session (`--resume <terminal> --fork-session`) so the chat starts
// knowing everything the terminal did, and later answers continue that fork (`--resume <fork>`). The terminal session
// itself is never written to - what the chat did reaches it as lines in this runner's chat log, which the terminal
// already follows. The project chat is answered the same way by the project's live runner, from Alfred's context only.
//
// Nothing here polls: messages arrive with the board's changes (board_wait), the terminal's transcript is watched with
// fs.watch events. Every line written to the chat log is already masked by the MCP server (chat_reply / chat_mirror).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { LIVE_TOOLS, Reporter, summaryOf, failureOf } from './alfred-live.mjs';

/**
 * The tools a chat run loads: the live ones plus the chat's own. A function: this module and alfred-live.mjs import each
 * other, so LIVE_TOOLS is read when a runner starts, not while the modules load.
 */
export function chatTools() {
  return [...LIVE_TOOLS, 'chat_reply', 'chat_read', 'chat_summary', 'chat_watch', 'board_list', 'get_brief', 'board_closed_reasons',
    'search_logs', 'problem_calls', 'triage', 'compare_cycles', 'check_calls', 'get_cycle', 'board_fix', 'board_requirements',
    'wait_for_calls', 'board_page_put', 'board_page_get', 'board_widget_put', 'board_snippet_view', 'board_lib', 'board_files', 'board_file'];
}

/** The tools whose call answers a chat message. */
export const CHAT_WRITES = /(^|__)chat_(reply|summary)$/;

/** A delta of terminal work larger than this re-forks instead of being passed as text (FR-055a). */
export const MAX_DELTA_CHARS = 24_000;

/**
 * The fixed head of every chat prompt - kept word for word the same so the model's prompt cache reuses it (FR-055e):
 * rules first, then Alfred's context, the summary, the terminal's new work, and the message last.
 */
export const CHAT_RULES = `You are the Claude of an Alfred board chat. You answer the user's chat messages below, each once, with chat_reply.
- Answer in plain words, in the user's language; evidence as mentions (@[call:in:<id>|label], #47, AC8 - shorthand becomes chips).
- Look things up first when the answer needs it (Alfred tools, the code in this folder); independent lookups in one turn. Change no file unless the user asks.
- Record what another session needs to continue (records on chat_reply): a decision -> DECISION; a new problem -> CARD; a new acceptance condition -> ITEM (the user accepts it); a code change you made -> board_fix on its card first (changed files as code mentions, the short diff, the re-test plan: expect + steps), then FIX; a question left open -> NEXT. Plain explanation and Q&A: no record.
- toTerminal.urgent only for: a decision that contradicts what the terminal session is doing, a change to files the terminal edited, a message the user addressed to the terminal ("@terminal"). The exchange itself reaches the terminal without you.
- Several messages waiting: answer each with its own chat_reply (messageId), oldest first, urgent first.
- A task "Compact this chat": write the summary with chat_summary (coversTo as the task says), then chat_reply to the task with one line.
- A task "Refresh from the terminal session": you were just re-copied from it; chat_reply to the task with one line saying so.
- A task "Watch while I test": check the new calls as one batch (wait_for_calls sinceCallId + settleSec, then check_calls); findings -> one chat_reply to the task (a later batch is a new task); nothing found -> chat_reply with extra {"quiet": true}.
- "Tell me when ..." -> chat_watch (it posts once and ends). Two calls side by side -> diff_calls; a long report -> board_page_put on the cycle and a mention of it.
- Graphs, dashboards, diagrams, reports: follow VISUALS below. The answer opens with its one-line finding in words; the visual backs it up.

VISUALS - the chat draws Markdown, fixed blocks and live snippets. Make it look designed, never improvised.
- Never hand-draw SVG with computed coordinates, never hard-code colours or a light theme, never paste rows of data into code: a snippet reads the data itself and the theme is already set.
- Pick the lightest form that says it:
  1. Markdown: \`## headings\`, tables (numbers in their own column), callouts (\`> [!NOTE]\` / \`[!WARNING]\` / \`[!TIP]\`), \`{red|text}\` \`{green|text}\`, mentions as evidence.
  2. Fixed blocks, drawn by the board: \`\`\`stats (lines \`label | value | colour | note\`, colour red|green|amber|blue|purple); \`\`\`chart (JSON {type: bar|hbar|line|area|pie, title, labels, series:[{name, values}], unit}); \`\`\`timeline (lines \`label | startMs | lengthMs | colour\`); \`\`\`mermaid (flowchart, sequenceDiagram, gantt, pie - themed for you; keep labels short, quote labels with symbols).
  3. Live data blocks: \`\`\`calls with lines \`cycle: <id>\` | \`since: 24h\`, \`endpoint: POST /x\`, \`show: table(status, ms, sql)\` or \`show: chart(ms, bar)\` - they re-read as calls arrive.
  4. A snippet - \`\`\`html live libs="echarts" - for anything richer: a dashboard, an interactive or combined chart, a sankey/heatmap/treemap, a call graph, a sortable table.
- A snippet runs in a locked frame (no network) with a design kit and Alfred's dark theme already applied. Write it like this:
  \`\`\`html live libs="echarts"
  <div class="grid"><div class="card kpi"><span class="label">Calls</span><span class="value" id="n">–</span><span class="note">this cycle</span></div></div>
  <div class="card"><h3>Slowest endpoints</h3><div id="c" class="chart" style="--h:300px"></div></div>
  <script type="module">
  const rows = await alfred.calls(); // this cycle's calls (else alfred.calls({since: '24h'})): ref, method, path, endpoint, status, signal, at, durationMs, statements, writes, dbMs, errors, warnings
  document.getElementById('n').textContent = alfred.fmt.num(rows.length);
  echarts.init(document.getElementById('c')).setOption({ tooltip: {trigger: 'axis'}, xAxis: {type: 'value'}, yAxis: {type: 'category', data: [...]}, series: [{type: 'bar', data: [...]}] });
  </script>
  \`\`\`
  - Always \`<script type="module">\` (own scope, top-level await). Data: \`await alfred.calls(args)\`, \`await alfred.data('statements'|'logs'|'rows'|'cards', args)\`.
  - Design kit classes: .grid (auto columns; style="--min:220px"), .row, .stack, .card, .kpi (.label .value .note), .badge.ok|.warn|.err|.info, .bar (style="--v:0.42", .err/.warn/.ok), .chart (height --h), .table-wrap around a long table, td.num for numbers, .muted, .up/.down. Plain h3/p/table/button already look right.
  - Helpers: alfred.fmt.ms(n) / num(n) / pct(x) / time(iso) / bytes(n) / path(url, max); alfred.palette (series colours); alfred.colors.ok|err|warn|info|accent.
  - Libraries (libs="..."): echarts - the default for charts (bar, line, scatter, pie, heatmap, sankey, treemap, gauge, dataZoom); apexcharts - dashboard charts and sparklines; chartjs; plot (Observable Plot, quick statistical charts); d3 - custom drawings; cytoscape - call/flow graphs; gridjs (+ its theme) - a sortable, searchable table; lucide - icons (<i data-lucide="clock"></i> then lucide.createIcons()); anime - motion; marked, highlight, dayjs, lodash, papaparse. ECharts, ApexCharts, Chart.js, Plotly, Plot and Mermaid get the dark theme and palette automatically - set no colours unless they mean something (red = error).
  - Good charts: a title that says the finding, sorted bars, horizontal bars for long labels (shorten paths with alfred.fmt.path), units on axes and tooltips, log scale only when values span 100x, at most ~8 colours, errors in alfred.colors.err.
  - It renders after you answer, so write it defensively: check the data is not empty and show a short message in the page when it is, wrap the body in try/catch and print the error into the page. chat_reply lists each snippet's id; when the user says it looks wrong, or you change it, board_snippet_view <id> shows its picture and console.
- A Markdown report: a bold one-line summary, a \`\`\`stats block of the key numbers, then ## sections with tables, a chart where a trend matters, evidence as mentions, a "## Next" section. Longer than a screen -> board_page_put and link it.
- Tool results are summaries; read the full body only when the answer needs it (the tool says how).
- The user asks you to change the board (move a card to any column - Inbox too, close it, verify it, mark a checklist item, add an acceptance item): you do not do it yourself and never tell the user to do it by hand - offer it in chat_reply's extra.proposals ({id, text, kind: move {card, status} | close {card, reason} | verify {card} | mark | item}); the user accepts it with one click. Never close, move to Verified/Done, or set scope yourself.`;

/** Where Claude Code keeps a session's transcript on this machine. */
export function transcriptPath(cwd, sessionId, home = homedir()) {
  return join(home, '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * How a chat run starts (research R3, FR-057/058): continue the chat's own session when it lives on this machine; else
 * fork the terminal session when its transcript is here; else a session of its own, started from Alfred's context.
 */
export function chatSessionArgs({ session = null, terminalId = null, transcriptExists = false, host = hostname(), refork = false } = {}) {
  if (!refork && session?.chatSessionId && (!session.host || session.host === host)) {
    return { args: ['--resume', session.chatSessionId], forked: false, continued: true, note: null };
  }
  if (terminalId && transcriptExists) {
    return { args: ['--resume', terminalId, '--fork-session'], forked: true, continued: false, note: null };
  }
  const note = terminalId ? `the terminal session is not on ${host} - this chat starts from Alfred's context only` : null;
  return { args: [], forked: false, continued: false, note };
}

/** The session id a stream-json run announces in its init event. */
export function sessionIdOf(msg) {
  return msg?.type === 'system' && msg?.subtype === 'init' && typeof msg.session_id === 'string' ? msg.session_id : null;
}

/** Urgent first, then the waiting order. */
export function orderChats(chats) {
  return [...chats].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || (a.seq ?? a.messageId) - (b.seq ?? b.messageId));
}

/** Which of the board's waiting chat messages this runner answers. */
export function mineOf(chats, { cycleId = null, project = null, kind = 'live' } = {}) {
  if (kind === 'listen') return [];
  return (chats ?? []).filter((c) => (cycleId ? c.scope === cycleId : c.scope === 'project' && (project == null || c.project === project)));
}

/**
 * The prompt of one chat run, in the order that keeps its head cached: rules, Alfred's context, the latest summary, the
 * terminal's work since the copy (when the session continues), then the messages.
 */
export function chatPrompt({ server, project, scope, taken, context = null, delta = null, note = null, alreadyInSession = false }) {
  const parts = [CHAT_RULES, `\nThe Alfred tools are mcp__${server}__* (e.g. mcp__${server}__chat_reply). Project "${project}", chat "${scope}".`];
  if (context && !alreadyInSession) parts.push(`\nALFRED CONTEXT:\n${context}`);
  if (alreadyInSession) parts.push('\n(The earlier chat, its summary and Alfred\'s context are already in your session - only what is new follows.)');
  if (note) parts.push(`\nNOTE: ${note}`);
  if (delta) parts.push(`\nTHE TERMINAL SESSION SINCE YOUR COPY (its significant work, newest last):\n${delta}`);
  parts.push('\nMESSAGES TO ANSWER:');
  for (const t of taken) {
    parts.push(`- messageId ${t.messageId}: ${t.take}${t.thread?.length ? `\n  thread:\n  ${t.thread.join('\n  ')}` : ''}`);
    const skill = skillOf(t.origin);
    if (skill) {
      parts.push(`  (the user picked /${skill} from the chat's "/" list: load it with the Skill tool and run it here, in your session, as far as`
        + ' your tools allow; answer with its result through chat_reply - what needs a tool you do not have, say, and give the command to run in'
        + ' the terminal.)');
    }
  }
  parts.push('\nAnswer them now.');
  return parts.join('\n');
}

/** The skills the chat's "/" list offers (FR-022): every shipped one except the two that run the chat. */
export const CHAT_SKILLS = ['alfred-guide', 'alfred-connect', 'alfred-setup', 'alfred-spec', 'alfred-review', 'alfred-triage', 'alfred-sync',
  'alfred-fix', 'alfred-verify', 'alfred-status', 'alfred-report', 'alfred-ask', 'alfred-update-skills'];

/** `skill:alfred-fix` → `alfred-fix` when it is one the chat offers. */
export function skillOf(origin) {
  const name = typeof origin === 'string' && origin.startsWith('skill:') ? origin.slice(6) : null;
  return name && CHAT_SKILLS.includes(name) ? name : null;
}

/** A line of the chat log for the terminal: ⚡ act on it before your next step; 💬 context only. */
export function terminalLine(item) {
  const text = String(item.text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  return item.urgent ? `⚡ board chat: ${text}` : text.startsWith('💬') ? text : `💬 board chat: ${text}`;
}

/**
 * The terminal's significant work since `since` (ms): the user's prompts and the assistant's text and file edits, from
 * the transcript lines (JSON per line). Tool noise is left out. Returns { text, at } - at = the newest entry's time.
 */
export function deltaOf(lines, since = 0) {
  const out = [];
  let at = since;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp ?? '') || 0;
    if (t <= since) continue;
    const content = e.message?.content;
    if (e.type === 'user' && typeof content === 'string' && !content.startsWith('<')) {
      out.push(`user: ${content.slice(0, 1500)}`);
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) out.push(`claude: ${c.text.trim().slice(0, 1500)}`);
        if (c.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) out.push(`claude edited ${c.input?.file_path ?? c.input?.notebook_path ?? 'a file'}`);
      }
    } else {
      continue;
    }
    at = Math.max(at, t);
  }
  return { text: out.join('\n'), at, entries: out.length };
}

/** Whether the transcript shows the terminal compacted itself after `since` (then a copy must be made again). */
export function compactedSince(lines, since = 0) {
  return lines.some((line) => {
    try {
      const e = JSON.parse(line);
      return (Date.parse(e.timestamp ?? '') || 0) > since && (e.type === 'summary' || e.isCompactSummary === true || e.subtype === 'compact_boundary');
    } catch { return false; }
  });
}

/**
 * Watches the terminal's transcript with fs.watch events (re-armed when the file is replaced) - the only trigger for
 * "the terminal moved on"; no timer. onChange(atMs) is called with the newest significant entry's time.
 */
export class TranscriptWatch {
  constructor(path, onChange, { fsWatch = watch } = {}) {
    this.path = path;
    this.onChange = onChange;
    this.fsWatch = fsWatch;
    this.size = 0;
    this.watcher = null;
    this.closed = false;
    this.arm();
  }

  arm() {
    if (this.closed || !existsSync(this.path)) return;
    try {
      this.size = statSync(this.path).size;
      this.watcher = this.fsWatch(this.path, (event) => {
        if (event === 'rename') { this.watcher?.close(); this.watcher = null; this.arm(); }
        this.read();
      });
    } catch { this.watcher = null; }
  }

  read() {
    try {
      const size = statSync(this.path).size;
      if (size < this.size) this.size = 0; // replaced
      if (size === this.size) return;
      // sizes are bytes: slice the bytes, not the decoded text (a transcript holds multi-byte characters)
      const text = readFileSync(this.path).subarray(this.size).toString('utf8');
      this.size = size;
      const d = deltaOf(text.split('\n'), 0);
      if (d.entries) this.onChange(d.at);
    } catch { /* gone for now; the next event re-arms */ }
  }

  close() {
    this.closed = true;
    this.watcher?.close();
  }
}

/**
 * The chat lane of a runner: takes this runner's waiting chat messages, answers each chat's in one run (FR-055c), keeps
 * the chat's session, reports live steps under the message, and writes what the chat sent the terminal to the chat log.
 */
export class ChatLane {
  /** @param runner the Runner (its options, MCP client, Alfred client, logs) @param pool a ClaudePool that keeps sessions */
  constructor(runner, pool) {
    this.r = runner;
    this.pool = pool;
    this.chains = new Map();
    this.host = runner.o.host ?? hostname();
    this.terminalAt = null;
    this.watch = null;
  }

  get chatId() {
    return this.r.o.chatId ?? `alfred-live:${this.host}:${this.r.o.project ?? ''}`;
  }

  /** Starts watching the terminal's transcript (cycle chats only); its newest work rides the heartbeat as terminalAt. */
  start() {
    if (!this.r.o.chatId || !this.r.o.cycleId) return;
    const path = transcriptPath(this.r.o.cwd ?? process.cwd(), this.r.o.chatId);
    this.watch = new TranscriptWatch(path, (at) => { this.terminalAt = new Date(at).toISOString(); });
  }

  stop() {
    this.watch?.close();
  }

  /** The waiting messages of one page of changes that this runner answers, one chain per chat. */
  handle(chats) {
    const mine = orderChats(mineOf(chats, { cycleId: this.r.o.cycleId ?? null, project: this.r.o.project ?? null, kind: this.r.o.kind ?? 'live' }));
    const byScope = new Map();
    for (const c of mine) byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), c]);
    for (const [scope, list] of byScope) {
      const prev = this.chains.get(scope) ?? Promise.resolve();
      const next = prev.then(() => this.answer(scope, list)).catch((error) => this.r.say(`  ⚠ chat ${scope}: ${error.message}`));
      this.chains.set(scope, next);
    }
    return Promise.all([...this.chains.values()]);
  }

  /** Takes one message: through the MCP tool (masked as the session says) when the runner has it, else straight from Alfred. */
  async take(c) {
    try {
      if (this.r.o.mcp) {
        const text = await this.r.o.mcp.call('chat_take', { project: c.project, scope: c.scope, messageId: c.messageId, chatId: this.chatId }, 30_000);
        const json = JSON.parse(text);
        if (!json.take) return null;
        return { messageId: c.messageId, take: json.take, thread: json.thread ?? [], summary: json.summary ?? null, task: c.kind === 'TASK', text: c.text,
          origin: c.origin ?? null };
      }
      const t = await this.r.o.alfred.call('POST', `/board/chats/messages/${c.messageId}/take`, { headers: { 'X-Alfred-Actor': 'claude' },
        body: { chatId: this.chatId, ...(c.scope === 'project' ? {} : { cycleId: c.scope }) } });
      const line = (m) => `#${m.id} ${m.author === 'USER' ? 'user' : m.author === 'CLAUDE' ? 'you' : 'Alfred'}: ${m.text}`;
      return { messageId: c.messageId, take: line(t.message), thread: (t.thread ?? []).map(line), summary: t.summary ? t.summary.text : null,
        task: c.kind === 'TASK', text: c.text, origin: c.origin ?? null };
    } catch (error) {
      this.r.o.log(`  · chat #${c.messageId} not taken: ${error.message}`);
      return null;
    }
  }

  async answer(scope, list) {
    const { alfred } = this.r.o;
    const project = list[0].project;
    const taken = (await Promise.all(list.map((c) => this.take(c)))).filter(Boolean);
    if (!taken.length) return; // FR-055h: nothing to answer, no run
    const ctx = await alfred.call('GET', `/board/chats/${encodeURIComponent(scope)}/context`, { query: { project } }).catch(() => null);
    const refork = taken.some((t) => t.task && /^Refresh from the terminal/.test(t.text ?? ''));
    const isCycle = scope !== 'project';
    const terminalId = isCycle ? this.r.o.chatId ?? null : null;
    const path = terminalId ? transcriptPath(this.r.o.cwd ?? process.cwd(), terminalId) : null;
    const lines = path && existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    const session = ctx?.session?.chatSessionId && ctx.session.chatSessionId !== 'null'
      ? { chatSessionId: ctx.session.chatSessionId, host: ctx.session.host === 'null' ? null : ctx.session.host } : null;
    // what the copy has read of the terminal: this runner's own memory, else Alfred's (a restarted runner)
    const seenUpTo = this.seenUpTo?.get(scope) ?? (Date.parse(ctx?.session?.seenUpTo ?? '') || 0);
    const delta = session && path ? deltaOf(lines, seenUpTo) : { text: '', at: seenUpTo, entries: 0 };
    // re-fork only after the terminal compacted itself or when the delta is too large (FR-055a)
    const mustRefork = refork || (session && path && (compactedSince(lines, seenUpTo) || delta.text.length > MAX_DELTA_CHARS));
    const how = chatSessionArgs({ session, terminalId, transcriptExists: !!path && existsSync(path), host: this.host, refork: mustRefork });
    const summary = taken.find((t) => t.summary)?.summary ?? null;
    const prompt = chatPrompt({
      server: this.r.o.server, project, scope, taken,
      context: [summary ? `Latest summary: ${summary}` : null, ctx?.decisions?.length ? `Decisions: ${ctx.decisions.map((d) => d.text).join(' | ')}` : null]
        .filter(Boolean).join('\n') || null,
      delta: how.continued && delta.entries ? delta.text : null,
      note: how.note,
      alreadyInSession: how.continued,
    });
    if (how.continued && delta.entries) {
      this.r.o.log(`  ↻ chat ${scope}: caught up (+${delta.entries} new entries from the terminal)`);
      await alfred.call('POST', `/board/chats/${encodeURIComponent(scope)}/system`, { query: { project },
        body: { text: `↻ caught up with the terminal session (+${delta.entries} new entries)` } }).catch(() => null);
    } else if (how.forked && session) {
      await alfred.call('POST', `/board/chats/${encodeURIComponent(scope)}/system`, { query: { project },
        body: { text: '↻ re-copied the terminal session' } }).catch(() => null);
    }
    if (how.forked) this.r.o.log(`  ⑂ chat ${scope}: copying the terminal session ${terminalId}`);

    const id = randomUUID();
    const reporter = new Reporter(alfred, { id, project, cardNumber: 0, chatMessageId: taken[0].messageId, head: 'answering in the chat' },
      { every: this.r.o.reportEveryMs ?? 250, onError: (error) => this.r.o.log(`  (live-work report failed: ${error.message})`) });
    reporter.report({ steps: [], state: 'WORKING' });
    const p = this.pool.acquire(how.args);
    let replied = 0;
    const handle = this.pool.run(p, prompt, {
      timeoutMs: this.r.o.runTimeoutMs ?? 10 * 60_000, draftEveryMs: this.r.o.draftEveryMs,
      onStep: async (step, steps, draft) => {
        if (step) this.r.o.log(`    · ${step}`);
        reporter.report({ steps, state: 'WORKING' }); // the answer arrives as its own message: no draft to stream
        return reporter.stop;
      },
      onToolResult: (_id, isError, _text, name) => { if (!isError && CHAT_WRITES.test(name)) replied++; },
    });
    this.r.handles.add(handle);
    reporter.onStop = () => handle.kill();
    const { steps, result, stderr, stopAsked, sessionId, usage } = await handle.done;
    this.r.handles.delete(handle);

    if (sessionId && (how.forked || !how.continued || sessionId !== session?.chatSessionId)) {
      await alfred.call('PUT', `/board/chats/${encodeURIComponent(scope)}/session`, { query: { project }, headers: { 'X-Alfred-Actor': 'claude' },
        body: { chatSessionId: sessionId, forkedFrom: how.forked ? terminalId : null, host: this.host, forkedAt: new Date().toISOString(),
          seenUpTo: new Date().toISOString() } }).catch((error) => this.r.o.log(`  (chat session not stored: ${error.message})`));
    }
    (this.seenUpTo ??= new Map()).set(scope, Math.max(delta.at, Date.now()));
    if (sessionId && how.continued && !how.forked && sessionId === session?.chatSessionId && delta.entries) {
      // caught up: Alfred keeps how far the copy has read, so the header stops saying "terminal moved on"
      await alfred.call('PUT', `/board/chats/${encodeURIComponent(scope)}/session`, { query: { project }, headers: { 'X-Alfred-Actor': 'claude' },
        body: { chatSessionId: sessionId, forkedFrom: null, host: this.host, forkedAt: null, seenUpTo: new Date(Math.max(delta.at, Date.now())).toISOString() } })
        .catch((error) => this.r.o.log(`  (chat session not stored: ${error.message})`));
    }
    if (stopAsked || this.r.stopped) {
      await reporter.end({ steps, state: 'STOPPED', outcome: 'stopped by you' });
    } else if (!result || result.error || replied < taken.length) {
      const why = !result || result.error ? failureOf(result, stderr) : `answered ${replied} of ${taken.length}`;
      await reporter.end({ steps, state: replied ? 'DONE' : 'FAILED', outcome: why });
      // what was taken and not answered goes back with a line saying why (the user can ask again)
      if (!replied) {
        for (const t of taken) {
          await alfred.call('POST', `/board/chats/messages/${t.messageId}/release`, { headers: { 'X-Alfred-Actor': 'claude' }, body: { failed: true, why } })
            .catch(() => null);
        }
      }
      this.r.say(`  ⚠ chat ${scope}: ${why}`);
    } else {
      await reporter.end({ steps, state: 'DONE', outcome: summaryOf(result?.text) ?? 'answered in the chat', ...(usage ? { usage } : {}) });
      this.r.o.log(`  → 💬 chat ${scope}: answered ${replied}`);
    }
    if (isCycle) await this.flushTerminal(scope, project);
  }

  /**
   * A comment on a cycle card that needs an investigation (FR-060): answered on the card by the cycle chat's session, in
   * turn with the chat's messages; the chat shows one line saying so.
   */
  answerCard(card, changes, prompt) {
    const scope = this.r.o.cycleId;
    const prev = this.chains.get(scope) ?? Promise.resolve();
    const next = prev.then(() => this.runCard(card, changes, prompt)).catch((error) => this.r.say(`  ⚠ #${card.number}: ${error.message}`));
    this.chains.set(scope, next);
    return next;
  }

  async runCard(card, changes, prompt) {
    const { alfred } = this.r.o;
    const scope = this.r.o.cycleId;
    const project = card.project ?? this.r.o.project ?? '';
    const ctx = await alfred.call('GET', `/board/chats/${encodeURIComponent(scope)}/context`, { query: { project } }).catch(() => null);
    const terminalId = this.r.o.chatId;
    const path = transcriptPath(this.r.o.cwd ?? process.cwd(), terminalId);
    const session = ctx?.session?.chatSessionId && ctx.session.chatSessionId !== 'null'
      ? { chatSessionId: ctx.session.chatSessionId, host: ctx.session.host === 'null' ? null : ctx.session.host } : null;
    const how = chatSessionArgs({ session, terminalId, transcriptExists: existsSync(path), host: this.host });
    const reporter = new Reporter(alfred, { id: randomUUID(), project, cardNumber: card.number, head: 'answering in the cycle chat' },
      { every: this.r.o.reportEveryMs ?? 250, onError: () => {} });
    reporter.report({ steps: [], state: 'WORKING' });
    let writes = 0;
    const handle = this.pool.run(this.pool.acquire(how.args), prompt, {
      timeoutMs: this.r.o.runTimeoutMs ?? 10 * 60_000, draftEveryMs: this.r.o.draftEveryMs,
      onStep: async (step, steps, draft) => { reporter.report({ steps, draft, state: 'WORKING' }); return reporter.stop; },
      onToolResult: (_id, isError, _text, name) => { if (!isError && /board_(reply|comment|ask)$/.test(name)) writes++; },
    });
    this.r.handles.add(handle);
    reporter.onStop = () => handle.kill();
    const { steps, result, stderr, stopAsked, sessionId, usage } = await handle.done;
    this.r.handles.delete(handle);
    if (sessionId && sessionId !== session?.chatSessionId) {
      await alfred.call('PUT', `/board/chats/${encodeURIComponent(scope)}/session`, { query: { project },
        body: { chatSessionId: sessionId, forkedFrom: how.forked ? terminalId : null, host: this.host, forkedAt: new Date().toISOString(),
          seenUpTo: new Date().toISOString() } }).catch(() => null);
    }
    if (stopAsked) { await reporter.end({ steps, state: 'STOPPED', outcome: 'stopped by you' }); return; }
    if (!result || result.error || !writes) {
      await reporter.end({ steps, state: 'FAILED', outcome: !result || result.error ? failureOf(result, stderr) : 'no reply posted' });
      return;
    }
    await reporter.end({ steps, state: 'DONE', outcome: summaryOf(result?.text) ?? 'answered on the card', ...(usage ? { usage } : {}) });
    await alfred.call('POST', `/board/chats/${encodeURIComponent(scope)}/system`, { query: { project },
      body: { text: `↳ answered your comment on #${card.number} "${String(card.title ?? '').slice(0, 80)}"` } }).catch(() => null);
  }

  /** What the chat sent the terminal, written to the chat log the terminal follows - then reported delivered. */
  async flushTerminal(scope, project) {
    const items = await this.r.o.alfred.call('GET', `/board/chats/${encodeURIComponent(scope)}/terminal`, { query: { project } }).catch(() => []);
    const open = (items ?? []).filter((t) => t.state === 'SENT' || t.state === 'WAITING' || t.state === 'QUEUED');
    if (!open.length) return 0;
    // urgent first; one write per item - the watch batches lines that arrive together into one turn
    for (const t of [...open].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.id - b.id)) this.r.o.chat?.(terminalLine(t));
    await this.r.o.alfred.call('POST', '/board/chats/terminal/delivered', { headers: { 'X-Alfred-Actor': 'claude' }, body: { ids: open.map((t) => t.id), read: false } })
      .catch(() => null);
    return open.length;
  }
}
