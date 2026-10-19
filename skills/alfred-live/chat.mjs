// The board chat lane of /alfred-live (specs/022, docs/board.md "Chat"). A chat is answered by the Claude session that ran
// /alfred-live for it - a board's chat by the board's session, the project chat by the project's - and by nothing else:
// each message becomes one line in this runner's chat log, which that session watches, and it answers with chat_reply.
// No fork, no copy, no headless run of the session (2026-10-19): while the session does not hear the log, its messages
// wait and the board says how to wake it (run /alfred-live there).
//
// Nothing here polls: messages arrive with the board's changes (board_wait), the terminal's transcript is watched with
// fs.watch events. Every line written to the chat log is already masked by the MCP server (chat_reply / chat_mirror).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { LIVE_TOOLS, Reporter } from './alfred-live.mjs';

/**
 * The tools a chat run loads: the live ones plus the chat's own. A function: this module and alfred-live.mjs import each
 * other, so LIVE_TOOLS is read when a runner starts, not while the modules load.
 */
export function chatTools() {
  return [...LIVE_TOOLS, 'chat_reply', 'chat_read', 'chat_summary', 'chat_watch', 'board_list', 'get_brief', 'board_closed_reasons',
    'search_logs', 'problem_calls', 'triage', 'compare_cycles', 'check_calls', 'get_cycle', 'board_fix', 'board_requirements',
    'wait_for_calls', 'board_page_put', 'board_page_get', 'board_widget_put', 'board_snippet_view', 'board_lib', 'board_files', 'board_file',
    ...TEAM_TOOLS];
}

/**
 * Every team_* tool (specs/027, 028, 030). Safe in a chat run: reads are live, every tracker write is a consent bundle the
 * user approves, and board/start/link changes need askedIn. Missing, the chat could not even prepare a state change.
 */
export const TEAM_TOOLS = ['team_search', 'team_saved', 'team_query', 'team_item', 'team_items_live', 'team_tree', 'team_attachment',
  'team_people', 'team_board_items', 'team_card_items', 'team_card_matches', 'team_incoming', 'team_watch_rules', 'team_watch_run',
  'team_board_link', 'team_board_unlink', 'team_link_card', 'team_unlink_card', 'team_create_item', 'team_comment', 'team_move_state',
  'team_set_field', 'team_bundle', 'team_redraft', 'team_propose_card', 'team_refresh_item', 'team_link', 'team_new_board', 'team_start'];

/** The tools whose call answers a chat message. */
export const CHAT_WRITES = /(^|__)chat_(reply|summary)$/;

/** The chat's rules, written next to the chat log for the session that answers it (chat-rules.md). */
export const CHAT_RULES = `You are the Claude of an Alfred board chat. You answer the user's chat messages below, each once, with chat_reply.
- Answer in plain words, in the user's language; evidence as mentions (@[call:in:<id>|label], #47, AC8 - shorthand becomes chips).
- Look things up first when the answer needs it (Alfred tools, the code in this folder); independent lookups in one turn. Change no file unless the user asks.
- Record what another session needs to continue (records on chat_reply): a decision -> DECISION; a new problem -> CARD; a new acceptance condition -> ITEM (the user accepts it); a code change you made -> board_fix on its card first (changed files as code mentions, the short diff, the re-test plan: expect + steps), then FIX; a question left open -> NEXT. Plain explanation and Q&A: no record.
- Several messages waiting: answer each with its own chat_reply (messageId), oldest first, urgent first.
- A task "Compact this chat": write the summary with chat_summary (coversTo as the task says), then chat_reply to the task with one line.
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

/** The session id a stream-json run announces in its init event. */
export function sessionIdOf(msg) {
  return msg?.type === 'system' && msg?.subtype === 'init' && typeof msg.session_id === 'string' ? msg.session_id : null;
}

/** Urgent first, then the waiting order. */
export function orderChats(chats) {
  return [...chats].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || (a.seq ?? a.messageId) - (b.seq ?? b.messageId));
}

/**
 * Which of the board's waiting chat messages this runner answers (specs/027 R6). A session bound to a board
 * (`/alfred-live <board>`, `cycleId` holding the board id) answers that board's chat; the project's session answers the
 * project chat. A board chat with no session of its own waits for one - never answered from another session or a copy.
 */
export function mineOf(chats, { cycleId = null, project = null, kind = 'live' } = {}) {
  if (kind === 'listen') return [];
  return (chats ?? []).filter((c) => (cycleId ? c.scope === cycleId : c.scope === 'project' && (project == null || c.project === project)));
}

/** The skills the chat's "/" list offers (FR-022): every shipped one except the two that run the chat. */
export const CHAT_SKILLS = ['alfred-guide', 'alfred-connect', 'alfred-setup', 'alfred-spec', 'alfred-review', 'alfred-triage', 'alfred-sync',
  'alfred-fix', 'alfred-verify', 'alfred-status', 'alfred-resume', 'alfred-report', 'alfred-ask', 'alfred-team', 'alfred-update-skills'];

/** `skill:alfred-fix` → `alfred-fix` when it is one the chat offers. */
export function skillOf(origin) {
  const name = typeof origin === 'string' && origin.startsWith('skill:') ? origin.slice(6) : null;
  return name && CHAT_SKILLS.includes(name) ? name : null;
}

/**
 * A cycle chat message handed to the terminal session that answers the chat (specs/022, plan-terminal-answers.md): one
 * chat-log line the session's Monitor wakes it with - it answers it itself with chat_reply. ⚡ = the user asked for it
 * first; a task or a skill the user picked says so.
 */
export function chatLine(t, { project, scope }) {
  const flat = (v, n) => { const x = String(v ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
  const skill = skillOf(t.origin);
  const what = skill ? `the user picked /${skill} from the chat's "/" list - run it here, answer with its result`
    : t.task ? 'a task from the chat - do it' : 'answer it';
  const ref = JSON.stringify({ project, scope, id: t.messageId });
  return `✉ board chat #${t.messageId}${t.urgent ? ' ⚡' : ''}: "${flat(t.text ?? t.take, 600)}" - ${what} in this session`
    + ` (chat_read ${ref} for its thread), then chat_reply {"project":${JSON.stringify(project)},"messageId":${t.messageId},…}`;
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

const base = (p) => String(p ?? '').split(/[\\/]/).pop();
const short = (v, n = 70) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** One tool call of the terminal, as the chat's progress line shows it: what it does, never its output. */
export function stepOf(name, input = {}) {
  const tool = String(name ?? '').replace(/^mcp__[^_]+(?:[-\w]*?)__/, '');
  switch (tool) {
    case 'Read': return `reading ${base(input.file_path)}`;
    case 'Edit': case 'Write': case 'NotebookEdit': return `editing ${base(input.file_path ?? input.notebook_path)}`;
    case 'Bash': case 'PowerShell': return short(input.description || input.command);
    case 'Grep': return `searching "${short(input.pattern, 40)}"`;
    case 'Glob': return `finding ${short(input.pattern, 40)}`;
    case 'Agent': return `subagent: ${short(input.description, 50)}`;
    case 'Skill': return `/${input.skill}`;
    case 'ToolSearch': return 'loading tools';
    case 'chat_read': return 'reading the chat thread';
    case 'chat_reply': return 'writing the answer';
    case 'board_get': return `reading card #${input.number ?? ''}`;
    case 'board_reply': return `answering on #${input.number ?? ''}`;
    default: return tool.replace(/_/g, ' ');
  }
}

/** What a transcript chunk says: the lines that reached the session (Monitor events) and the tool calls it made. */
export function terminalEvents(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    // a background task of the session ended (stopped, killed, failed or done): when it is the one that delivered the
    // ✉ lines, nothing hears the chat log any more (Pause, a Desktop restart, a compact, the user's own stop)
    const ended = e.type === 'user' && raw.includes('task-notification') ? /<status>(stopped|killed|failed|completed)<\/status>/.exec(raw) : null;
    if (ended && !raw.includes('Monitor event')) out.push({ kind: 'tasksEnded', ids: taskIdsOf(raw), raw });
    else if (e.type === 'user' && raw.includes('✉')) out.push({ kind: 'received', raw, ids: taskIdsOf(raw) });
    else if (e.type === 'queue-operation' && e.operation === 'enqueue' && raw.includes('✉')) out.push({ kind: 'queued', raw });
    else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === 'tool_use') out.push({ kind: 'tool', name: c.name, input: c.input ?? {} });
        else if (c?.type === 'thinking') out.push({ kind: 'thinking' });
      }
      // the turn's last answer: whatever the terminal took up in that turn is done, however it answered
      if (e.message.stop_reason === 'end_turn') out.push({ kind: 'turnEnd' });
    }
  }
  return out;
}

/** The background task ids a task notification names. */
export function taskIdsOf(raw) {
  return [...String(raw).matchAll(/<task-id>([^<\\]+)<\\?\/task-id>/g)].map((m) => m[1].trim()).filter((id) => id && !id.startsWith('__'));
}

/** How long a handed message may go without the session taking it up before the board is told it does not listen. */
export const ACK_MS = 90_000;

/**
 * Watches the terminal's transcript with fs.watch events (re-armed when the file is replaced) - the only trigger for
 * "the terminal moved on"; no timer. onChange(atMs) is called with the newest significant entry's time.
 */
export class TranscriptWatch {
  constructor(path, onChange, { fsWatch = watch, onRaw = null } = {}) {
    this.path = path;
    this.onChange = onChange;
    this.onRaw = onRaw;
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
      if (d.entries) this.onChange(d.at, text);
      else this.onRaw?.(text);
    } catch { /* gone for now; the next event re-arms */ }
  }

  close() {
    this.closed = true;
    this.watcher?.close();
  }
}

/**
 * The chat lane of a runner: takes this runner's waiting chat messages, hands each to the session as a chat-log line and
 * reports its live steps under the message from the session's transcript - nothing is answered here.
 */
export class ChatLane {
  /** @param runner the Runner (its options, MCP client, Alfred client, logs) */
  constructor(runner) {
    this.r = runner;
    this.chains = new Map();
    this.host = runner.o.host ?? hostname();
    this.terminalAt = null;
    this.watch = null;
    /** What was handed to the terminal and is not answered yet: its live progress under the message or card. */
    this.pending = new Map();
    this.follow = null;
    /** The terminal's background tasks seen delivering ✉ lines - when one of them ends, nobody hears the chat log. */
    this.listeners = new Set();
    /**
     * Since when the session does not hear the chat log (its watch ended, or a handed message was not taken up within
     * ACK_MS): its messages wait, and the board says so, until it watches the log again. Before this, a message handed to
     * a deaf session said "Claude has it" for ever (2026-10-19: a Desktop restart ended the watch).
     */
    this.deafSince = null;
  }

  get chatId() {
    return this.r.o.chatId ?? `alfred-live:${this.host}:${this.r.o.project ?? ''}`;
  }

  /** The chat this lane answers: the runner's board, else the project chat. */
  get scope() {
    return this.r.o.cycleId ?? 'project';
  }

  /**
   * The chat is answered by the session that ran /alfred-live (plan-terminal-answers.md): its transcript is followed from
   * the start, so a watch that ends is seen even while nothing is pending, and Alfred is told the session answers.
   */
  async start() {
    if (!this.r.o.chatId) return;
    this.followTerminal();
    if (this.deafSince) {
      // its watch ended before this runner started: the board says so once, and its messages wait for it
      if (!this.toldDeaf) this.tellDeaf(this.deafWhy ?? 'its watch on the chat log ended');
      return;
    }
    if (!this.r.o.cycleId) return; // the project chat: no board chat session to name
    await this.r.o.alfred.call('PUT', `/board/chats/${encodeURIComponent(this.r.o.cycleId)}/session`, {
      query: { project: this.r.o.project ?? '' }, headers: { 'X-Alfred-Actor': 'claude' },
      body: { chatSessionId: this.r.o.chatId, forkedFrom: this.r.o.chatId, host: this.host, forkedAt: null, seenUpTo: null },
    }).catch((error) => this.r.o.log(`  (could not tell Alfred the session answers the chat: ${error.message})`));
  }

  stop() {
    this.watch?.close();
    this.follow?.close();
    for (const p of this.pending.values()) p.reporter.end({ steps: p.steps, state: 'DONE', outcome: 'the runner stopped - your terminal still has it' }).catch(() => null);
    this.pending.clear();
  }

  /**
   * Shows the terminal's work on something handed to it (plan-terminal-answers.md): waiting -> on it -> each tool step,
   * read from the terminal's transcript by fs.watch events (no timer), until the terminal's reply to it. The steps are
   * Alfred's live progress only - never stored.
   */
  track({ key, marker, reporter, done }) {
    const steps = [];
    this.pending.set(key, { key, marker, reporter, done, steps, picked: false });
    reporter.report({ steps, state: 'WORKING', head: 'waiting for your terminal to be free' });
    reporter.onStop = () => {
      this.r.o.chat?.(`⏹ ${marker}: the user pressed Stop - stop working on it and answer nothing more for it.`);
      this.untrack(key, { state: 'STOPPED', outcome: 'stopped - your terminal was told' });
    };
    this.followTerminal();
  }

  followTerminal() {
    if (this.follow || !this.r.o.chatId) return;
    const path = transcriptPath(this.r.o.cwd ?? process.cwd(), this.r.o.chatId);
    // where the terminal stands now: a runner started by ▶ Resume, after a Desktop restart, must not hand a message to a
    // watch that ended before it started (read once, quietly - the board hears only of a change from here on)
    if (existsSync(path)) {
      try {
        const size = statSync(path).size;
        const text = readFileSync(path, 'utf8');
        this.replaying = true;
        this.onTerminal(size > 4_000_000 ? text.slice(-4_000_000) : text);
      } catch { /* unreadable now: judged by what comes next */ } finally { this.replaying = false; }
    }
    this.follow = new TranscriptWatch(path, (_, text) => this.onTerminal(text ?? ''), { onRaw: (text) => this.onTerminal(text) });
  }

  /**
   * The session stopped hearing the chat log: what it was handed and has not taken up goes back to waiting, the board
   * says how to wake it, and nothing is answered until it watches the log again ({@link hear}) - never in a copy.
   */
  goDeaf(why) {
    if (this.deafSince || !this.r.o.chatId) return;
    this.deafSince = Date.now();
    this.deafWhy = why;
    this.toldDeaf = false;
    this.r.o.log(`  ⚠ your session is not listening (${why}) - its messages wait until it runs /alfred-live again`);
    this.r.beat?.(); // the board shows "not listening" now, not at the next heartbeat
    // replaying the transcript at start: start() tells the board once the replay is over (it may still hear again)
    if (this.replaying) return;
    this.tellDeaf(why);
    for (const p of [...this.pending.values()].filter((x) => x.item && !x.seen)) {
      this.untrack(p.key, { state: 'DONE', outcome: 'your session is not listening - the message waits for it' });
      this.r.o.alfred.call('POST', `/board/chats/messages/${p.item.t.messageId}/release`, { headers: { 'X-Alfred-Actor': 'claude' },
        body: { failed: false } }).catch(() => null);
    }
  }

  /** Says on the board and in the session's chat log that the session does not hear the chat - once per deaf spell. */
  tellDeaf(why) {
    this.toldDeaf = true;
    const project = this.r.o.project ?? '';
    this.r.o.chat?.(`⚠ this session stopped hearing the board (${why}) - its messages wait. To answer them, run /alfred-live here again.`);
    this.r.o.alfred.call('POST', `/board/chats/${encodeURIComponent(this.scope)}/system`, { query: { project },
      body: { text: `↪ Your session stopped listening (${why}) - your messages wait for it. Open the session and send /alfred-live to answer them.` } })
      .catch(() => null);
  }

  /** The session watches the chat log again: Alfred is told it answers, and what waited is handed to it now. */
  hear() {
    if (!this.deafSince) return;
    this.deafSince = null;
    if (this.replaying) return;
    this.r.o.log('  ✓ your session watches the chat log again - its messages go to it');
    this.r.beat?.();
    this.start().catch(() => null);
    this.r.rereadChats?.();
  }

  /** A card change that waits while the session does not hear the chat log: handed to it when it watches again. */
  hold(key, hand) {
    (this.held ??= new Map()).set(key, hand);
  }

  /** Hands the held card changes to the session, which hears the chat log again. */
  flushHeld() {
    if (this.deafSince || !this.held?.size) return;
    const held = [...this.held.values()];
    this.held.clear();
    for (const hand of held) hand();
  }

  untrack(key, end) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    p.reporter.end({ steps: p.steps, ...end }).catch(() => null);
  }

  onTerminal(text) {
    for (const ev of terminalEvents(text)) {
      if (ev.kind === 'received') {
        for (const id of ev.ids ?? []) this.listeners.add(id);
        this.hear();
      } else if (ev.kind === 'tasksEnded') {
        const mine = (ev.ids ?? []).some((id) => this.listeners.has(id)) || (!this.listeners.size && /Alfred live/.test(ev.raw));
        if (mine) {
          for (const id of ev.ids ?? []) this.listeners.delete(id);
          this.goDeaf('its watch on the chat log ended');
        }
        continue;
      } else if (ev.kind === 'tool' && this.deafSince && this.watchesChatLog(ev.input)) {
        this.hear(); // it started watching the chat log again (it ran /alfred-live)
      }
      for (const p of [...this.pending.values()]) {
        if ((ev.kind === 'received' || ev.kind === 'queued') && ev.raw.includes(p.marker)) {
          p.seen = true;
          if (ev.kind === 'received') p.picked = true;
          p.reporter.report({ steps: p.steps, state: 'WORKING',
            head: ev.kind === 'received' ? 'working on it in your terminal' : 'queued in your terminal after its current step' });
          continue;
        }
        // its reply ends it even when no "received" was seen: a message queued while the terminal was busy reaches it
        // inside a later turn, often with no event of its own, and its row then stayed "queued" after the reply
        if (ev.kind === 'tool' && p.done(ev.name, ev.input)) {
          this.untrack(p.key, { state: 'DONE', outcome: 'answered by your terminal' });
          continue;
        }
        // a turn that took it up and ended without the expected reply (it commented, moved the card, or decided
        // nothing was needed) still finished it - the row said "working" for ever before (2026-10-18, #76)
        if (ev.kind === 'turnEnd' && p.picked) {
          this.untrack(p.key, { state: 'DONE', outcome: 'handled by your terminal' });
          continue;
        }
        if (!p.picked) continue;
        const step = ev.kind === 'thinking' ? 'thinking' : stepOf(ev.name, ev.input);
        if (p.steps.at(-1) === step) continue;
        p.steps.push(step);
        p.reporter.report({ steps: p.steps.slice(-40), state: 'WORKING', head: `working in your terminal: ${step}` });
      }
    }
  }

  /** On the runner's heartbeat: a handed message the terminal has not taken up in ACK_MS means it does not hear the log. */
  checkDeadlines(now = Date.now()) {
    const ack = this.r.o.ackMs ?? ACK_MS;
    const late = [...this.pending.values()].find((p) => p.item && !p.seen && now - (p.handedAt ?? now) >= ack);
    if (late) this.goDeaf(`it did not take up board chat #${late.item.t.messageId} within ${Math.round(ack / 1000)} s`);
  }

  /** Whether a tool call of the terminal watches this runner's chat log (a tail or Monitor on it). */
  watchesChatLog(input) {
    const path = this.r.o.chatPath;
    if (!path) return false;
    const name = path.split(/[\\/]/).pop();
    return !!name && JSON.stringify(input ?? {}).includes(name);
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
    // a board chat a terminal holds refuses the project runner's take: leave it alone for a minute (specs/027 R6)
    const refusedAt = (this.refused ??= new Map()).get(c.messageId);
    if (refusedAt && Date.now() - refusedAt < 60_000) return null;
    const refuse = () => { if (c.scope !== 'project' && !this.r.o.cycleId) this.refused.set(c.messageId, Date.now()); return null; };
    try {
      if (this.r.o.mcp) {
        const text = await this.r.o.mcp.call('chat_take', { project: c.project, scope: c.scope, messageId: c.messageId, chatId: this.chatId }, 30_000);
        const json = JSON.parse(text);
        if (!json.take) return refuse();
        return { messageId: c.messageId, take: json.take, thread: json.thread ?? [], summary: json.summary ?? null, task: c.kind === 'TASK', text: c.text,
          origin: c.origin ?? null };
      }
      const t = await this.r.o.alfred.call('POST', `/board/chats/messages/${c.messageId}/take`, { headers: { 'X-Alfred-Actor': 'claude' },
        body: { chatId: this.chatId, ...(c.scope === 'project' ? {} : { cycleId: c.scope }) } });
      const line = (m) => `#${m.id} ${m.author === 'USER' ? 'user' : m.author === 'CLAUDE' ? 'you' : 'Alfred'}: ${m.text}`;
      return { messageId: c.messageId, take: line(t.message), thread: (t.thread ?? []).map(line), summary: t.summary ? t.summary.text : null,
        task: c.kind === 'TASK', text: c.text, origin: c.origin ?? null };
    } catch (error) {
      if (c.scope !== 'project' && !this.r.o.cycleId) return refuse();
      this.r.o.log(`  · chat #${c.messageId} not taken: ${error.message}`);
      return null;
    }
  }

  async answer(scope, list) {
    const project = list[0].project;
    // only the session that ran /alfred-live answers: with none, or while it does not hear the log, the messages wait
    if (!this.r.o.chatId || !this.r.o.chat) {
      if (!this.toldNoSession) {
        this.toldNoSession = true;
        this.r.o.log('  ⚠ no Claude session follows this runner - chat messages wait; run /alfred-live in a Claude session to answer them');
      }
      return;
    }
    if (this.deafSince) return;
    const taken = (await Promise.all(list.map((c) => this.take(c)))).filter(Boolean);
    if (!taken.length) return; // FR-055h: nothing to answer, no run
    return this.toTerminal(scope, project, list, taken);
  }

  /**
   * A cycle chat is answered by the terminal session that ran /alfred-live (plan-terminal-answers.md): the messages are
   * taken for it (WAITING → TAKEN) and each becomes one chat-log line; the session answers them itself. No copy, no run -
   * nothing of the work is stored here. A line that cannot be written gives its message back.
   */
  async toTerminal(scope, project, list, taken) {
    const urgent = new Set(list.filter((c) => c.urgent).map((c) => c.messageId));
    if (!this.r.o.chat) {
      for (const t of taken) {
        await this.r.o.alfred.call('POST', `/board/chats/messages/${t.messageId}/release`, { headers: { 'X-Alfred-Actor': 'claude' },
          body: { failed: true, why: 'no terminal session follows this runner' } }).catch(() => null);
      }
      return;
    }
    for (const t of [...taken].sort((a, b) => Number(urgent.has(b.messageId)) - Number(urgent.has(a.messageId)))) {
      const reporter = new Reporter(this.r.o.alfred, { id: randomUUID(), project, cardNumber: 0, chatMessageId: t.messageId, head: 'waiting for your terminal to be free' },
        { every: this.r.o.reportEveryMs ?? 250, onError: (error) => this.r.o.log(`  (live-work report failed: ${error.message})`) });
      const key = `m:${t.messageId}`;
      this.track({ key, marker: `✉ board chat #${t.messageId}`, reporter,
        done: (name, input) => /(^|__)chat_reply$/.test(name) && Number(input.messageId) === t.messageId });
      // delivered means the terminal took it up or queued it; silence past the deadline means nothing hears the log
      // (checked on the runner's heartbeat - checkDeadlines - never a timer of the lane's own)
      Object.assign(this.pending.get(key), { item: { project, t }, handedAt: Date.now() });
      this.r.o.chat(chatLine({ ...t, urgent: urgent.has(t.messageId) }, { project, scope }));
    }
    this.r.o.log(`  → 💬 chat ${scope}: ${taken.length} message${taken.length === 1 ? '' : 's'} handed to the terminal session`);
  }
}
