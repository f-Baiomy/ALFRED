import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { chunkText, invalid, ok, run, type ToolReply } from '../reply.ts';
import { cardByNumber } from './board.ts';

/**
 * The board's visuals for Claude (specs/017 R24, R29-R32, R38, R41): questions asked from a snippet or the editor,
 * pages (named HTML snippets and diagrams on a card, cycle or project), what a snippet drew, and the library shelf.
 * Writes go as Claude: Claude creates pages and changes only its own (Alfred refuses the rest).
 */
const AS_CLAUDE: Pick<RequestOptions, 'headers' | 'timeoutMs'> = { headers: { 'X-Alfred-Actor': 'claude' }, timeoutMs: 30_000 };
const Project = z.string().default('').describe('Project name; "" is "No project"');
const PAGE_CHUNK = 12_000;

interface AskRow {
  id: string; project: string; cycleId: string | null; cardNumber: number | null; snippetId: string | null; kind: 'SNIPPET' | 'EDITOR';
  question: string; data: string | null; state: string; answer: string | null; createdAt: string;
}

interface PageRow {
  id: string; ownerType: string; ownerId: string; project: string; name: string; kind: string; info: string; source: string | null;
  author: string; pinned: boolean; version: number; updatedAt: string; updatedBy: string;
}

/** Where a page lives: a card (by number), a cycle, or the project. */
async function owner(client: AlfredClient, input: { project: string; number?: number; cycleId?: string }): Promise<string> {
  if (input.number != null) return `card:${(await cardByNumber(client, input.project, input.number)).id}`;
  if (input.cycleId) return `cycle:${input.cycleId}`;
  if (!input.project) throw invalid('Say where the page goes: number (a card), cycleId, or a project');
  return `project:${input.project}`;
}

interface FileRow { id: string; name: string; mime: string; size: number; author: string; createdAt: string; cardId: string | null; cycleId: string | null }

interface WidgetRow { project: string; name: string; kind: string; info: string; source?: string | null; author: string; updatedAt: string }

const fileLine = (f: FileRow) => ({ id: f.id, name: f.name, type: f.mime, size: f.size, by: f.author, at: f.createdAt });

const page = (p: PageRow) => ({ id: p.id, name: p.name, kind: p.kind, info: p.info, version: p.version, author: p.author, pinned: p.pinned,
  updatedAt: p.updatedAt, updatedBy: p.updatedBy });

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_ask_get', {
    description: 'A question the user asked you from the board (the /alfred-ask <id> run): from a snippet (alfred.ask - its data is what the snippet '
      + 'attached) or from the text editor (✦ - data.selection is the selected text, data.text the whole text, data.format html|markdown). '
      + 'Answer it with board_ask_answer.',
    inputSchema: { id: z.string().min(8).max(64) },
  }, (input) => run(async () => {
    const a = await client.get<AskRow>(`/board/asks/${seg(input.id)}`, { notFound: `No ask ${input.id}` });
    let data: unknown = a.data;
    try { data = a.data ? JSON.parse(a.data) : null; } catch { /* kept as text */ }
    const json = JSON.stringify(data ?? null);
    const how = a.kind === 'EDITOR'
      ? 'Answer with the replacement text only - Markdown in the board\'s syntax (fences ```chart/```stats/```html live, {red|colour}, @[call:…] mentions) - no preamble: the user accepts it into the text.'
      : 'Answer in plain words (or JSON if the snippet asked for data) - the snippet receives your text as the answer to alfred.ask().';
    return ok({ id: a.id, state: a.state, kind: a.kind, question: a.question, project: a.project, cycleId: a.cycleId,
      card: a.cardNumber != null ? `#${a.cardNumber}` : null, snippet: a.snippetId, answer: a.answer,
      data: json.length > 10_000 ? `${json.slice(0, 10_000)}… (${json.length} characters; the rest is not shown)` : data, how });
  }));

  server.registerTool('board_ask_answer', {
    description: 'Answer a question asked from the board (board_ask_get first). The asking snippet or editor shows your answer at once.',
    inputSchema: { id: z.string().min(8).max(64), text: z.string().min(1).max(256 * 1024) },
  }, (input) => run(async () => {
    await client.put(`/board/asks/${seg(input.id)}/answer`, { ...AS_CLAUDE, body: { text: input.text } });
    return ok({ answered: input.id });
  }));

  server.registerTool('board_pages', {
    description: 'The pages of a card (number), a cycle (cycleId) or a project (neither): named HTML pages and diagrams shown as tabs. '
      + 'Read one with board_page_get; see what it drew with board_snippet_view.',
    inputSchema: { project: Project, number: z.number().int().min(1).optional(), cycleId: z.string().optional() },
  }, (input) => run(async () => {
    const o = await owner(client, input);
    const list = await client.get<PageRow[]>('/board/pages', { query: { owner: o, ...(o.startsWith('cycle:') ? { project: input.project } : {}) } });
    return ok({ owner: o, pages: list.map(page) });
  }));

  server.registerTool('board_page_get', {
    description: 'One page\'s source (HTML, Mermaid or Python) - a version of it with version - in parts of 12,000 characters (offset).',
    inputSchema: { id: z.string().min(8).max(64), version: z.number().int().min(1).optional(), offset: z.number().int().min(0).default(0) },
  }, (input) => run(async () => {
    const p = await client.get<PageRow>(`/board/snippets/${seg(input.id)}`, { query: input.version ? { version: input.version } : {}, notFound: `No page ${input.id}` });
    const part = chunkText(p.source ?? '', input.offset, PAGE_CHUNK);
    return ok({ ...page(p), source: part.text, offset: part.offset, totalLength: part.totalLength, nextOffset: part.nextOffset });
  }));

  server.registerTool('board_page_put', {
    description: 'Create a page (no id) on a card (number), a cycle (cycleId) or the project - or save a new version of one you created (id; '
      + 'baseVersion = the version you read, so a newer save by the user is not overwritten). kind html (default), mermaid, python '
      + '(```python live: await alfred.calls(...) is a pandas DataFrame, matplotlib figures are drawn) or block (one board fence, e.g. a ```chart). '
      + 'A multi-file HTML page: "--- chart.js" / "--- look.css" / "--- rows.csv" lines start files (import "./chart.js"; alfred.file("rows.csv")). '
      + 'info: the settings, e.g. live libs="echarts" height=420. A page runs in a locked frame with no network: read Alfred\'s data '
      + 'with alfred.data()/alfred.watch() (calls, call, statements, rows, logs, redis, cards, card, cycles, rules), use only the '
      + 'shelf (board_lib), keep state with alfred.state. After saving, open it once on the board, then board_snippet_view to check it.',
    inputSchema: {
      project: Project, number: z.number().int().min(1).optional(), cycleId: z.string().optional(), id: z.string().optional(),
      name: z.string().min(1).max(120), kind: z.enum(['html', 'mermaid', 'python', 'block']).default('html'), info: z.string().max(500).default('live'),
      source: z.string().max(256 * 1024), baseVersion: z.number().int().min(1).optional(),
    },
  }, (input) => run(async () => {
    if (input.id) {
      const p = await client.put<PageRow>(`/board/snippets/${seg(input.id)}`, { ...AS_CLAUDE,
        body: { name: input.name, info: input.info, source: input.source, ...(input.baseVersion ? { baseVersion: input.baseVersion } : {}) } });
      return ok({ saved: page(p) });
    }
    const o = await owner(client, input);
    const p = await client.post<PageRow>('/board/pages', { ...AS_CLAUDE,
      body: { owner: o, project: input.project, name: input.name, kind: input.kind.toUpperCase(), info: input.info, source: input.source } });
    return ok({ created: page(p) });
  }));

  server.registerTool('board_snippet_view', {
    description: 'What a snippet drew, as a picture, with its console (errors and console.log) - for a page (its id) or a block in a text '
      + '(inline:card:<cardId>:desc:<n>, inline:card:<cardId>:<commentEntryId>:<n>, inline:cycle:<cycleId>:goal|desc|o<k>:<n>, '
      + 'inline:chat:<answerMessageId>:a:<n> - chat_reply lists them). '
      + 'Alfred keeps one after each version is first shown on the board; none yet = nobody has opened it since it changed.',
    inputSchema: { id: z.string().min(8).max(200) },
  }, (input) => run(async () => {
    const meta = await client.get<{ version: number; at: string; console: string }>(`/board/snippets/${seg(input.id)}/shot`,
      { query: { png: 'false' }, notFound: `No picture of ${input.id} yet - it is drawn when someone opens it on the board` });
    const png = await client.bytes(`/board/snippets/${seg(input.id)}/shot.png`);
    const consoleText = meta.console.length > 6000 ? `${meta.console.slice(-6000)} (last 6,000 characters)` : meta.console;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ id: input.id, version: meta.version, at: meta.at, console: consoleText || '(nothing logged)' }) },
        { type: 'image', data: png.data.toString('base64'), mimeType: 'image/png' },
      ],
    } as unknown as ToolReply;
  }));

  server.registerTool('board_pin', {
    description: 'Pin a page to the top of its card or cycle brief - its dashboard, always open - or unpin it (pinned=false). '
      + 'Only your own pages; ask the user to pin theirs.',
    inputSchema: { id: z.string().min(8).max(64), pinned: z.boolean().default(true) },
  }, (input) => run(async () => {
    const p = await client.put<PageRow>(`/board/snippets/${seg(input.id)}`, { ...AS_CLAUDE, body: { pinned: input.pinned } });
    return ok({ [input.pinned ? 'pinned' : 'unpinned']: page(p) });
  }));

  server.registerTool('board_files', {
    description: 'The files attached to a card (number) or a cycle (cycleId): name, type, size, who attached it. Read one with board_file.',
    inputSchema: { project: Project, number: z.number().int().min(1).optional(), cycleId: z.string().optional() },
  }, (input) => run(async () => {
    const query = input.number != null ? { card: (await cardByNumber(client, input.project, input.number)).id } : input.cycleId ? { cycle: input.cycleId } : null;
    if (!query) throw invalid('Name a card (number) or a cycle (cycleId)');
    const list = await client.get<FileRow[]>('/board/files', { query });
    return ok({ files: list.map(fileLine) });
  }));

  server.registerTool('board_file', {
    description: 'One attached file (id from board_files): text (csv, json, log, har, xml, sql, md, txt) in parts of 12,000 characters '
      + '(offset); a PNG/JPEG as the picture itself; a PDF only by its size (the user opens it from the board).',
    inputSchema: { id: z.string().min(8).max(64), offset: z.number().int().min(0).default(0) },
  }, (input) => run(async () => {
    const bytes = await client.bytes(`/board/files/${seg(input.id)}`);
    if (bytes.mime.startsWith('image/')) {
      return { content: [{ type: 'image', data: bytes.data.toString('base64'), mimeType: bytes.mime }] } as unknown as ToolReply;
    }
    if (bytes.mime === 'application/pdf') return ok({ id: input.id, type: 'PDF', size: bytes.data.length, note: 'A PDF - the user opens it from the card' });
    const part = chunkText(bytes.data.toString('utf8'), input.offset, PAGE_CHUNK);
    return ok({ id: input.id, type: bytes.mime, text: part.text, offset: part.offset, totalLength: part.totalLength, nextOffset: part.nextOffset });
  }));

  server.registerTool('board_attach', {
    description: 'Attach a text file you made (csv, json, md, txt, log, sql, xml, har - at most 10 MB) to a card (number) or a cycle '
      + '(cycleId): a table of numbers for a snippet to read with alfred.files(name), a query, an extract. Link it in a comment as '
      + '[📎 name](/board/files/<id>).',
    inputSchema: { project: Project, number: z.number().int().min(1).optional(), cycleId: z.string().optional(),
      name: z.string().min(3).max(120), text: z.string().min(1).max(10 * 1024 * 1024) },
  }, (input) => run(async () => {
    const query = input.number != null ? { card: (await cardByNumber(client, input.project, input.number)).id, name: input.name }
      : input.cycleId ? { cycle: input.cycleId, project: input.project, name: input.name } : null;
    if (!query) throw invalid('Name a card (number) or a cycle (cycleId)');
    const f = await client.post<FileRow>('/board/files', { ...AS_CLAUDE, query, rawBody: input.text });
    return ok({ attached: fileLine(f), link: `[📎 ${f.name}](/board/files/${f.id})` });
  }));

  server.registerTool('board_widgets', {
    description: "A project's widgets - named visuals used in any of its texts as {{widget:name | key=value}} on a line of its own "
      + '({{key}} in the widget takes the value). With name: that widget with its source.',
    inputSchema: { project: Project, name: z.string().optional() },
  }, (input) => run(async () => {
    if (input.name) return ok(await client.get<WidgetRow>(`/board/widgets/${seg(input.name)}`, { query: { project: input.project }, notFound: `No widget ${input.name}` }));
    const list = await client.get<WidgetRow[]>('/board/widgets', { query: { project: input.project } });
    return ok({ widgets: list.map((w) => ({ name: w.name, kind: w.kind, author: w.author, updatedAt: w.updatedAt })) });
  }));

  server.registerTool('board_widget_put', {
    description: "Create a widget of the project, or replace one you created (never the user's): kind html, mermaid, python or block "
      + '(board Markdown, e.g. a ```chart fence). Write {{key}} where a value given at use goes (an HTML widget also gets them as '
      + 'alfred.context.params). Then tell the user the line to use: {{widget:name | key=value}}.',
    inputSchema: { project: Project, name: z.string().regex(/^[A-Za-z0-9][\w-]{0,59}$/), kind: z.enum(['html', 'mermaid', 'python', 'block']).default('html'),
      info: z.string().max(500).default(''), source: z.string().min(1).max(256 * 1024) },
  }, (input) => run(async () => {
    const w = await client.put<WidgetRow>(`/board/widgets/${seg(input.name)}`, { ...AS_CLAUDE, query: { project: input.project },
      body: { kind: input.kind.toUpperCase(), info: input.info, source: input.source } });
    return ok({ saved: { name: w.name, kind: w.kind }, use: `{{widget:${w.name}}}` });
  }));

  server.registerTool('board_lib', {
    description: 'Alfred\'s library shelf - the only libraries a snippet can load (it has no network): id, version, kind (script = a global '
      + 'named by provides; module = import from provides; css), what it is for. Load with libs="id id" on the snippet or alfred.lib(id).',
    inputSchema: {},
  }, () => run(async () => {
    const index = await client.get<{ libs: { id: string; version: string; kind: string; provides: string; about: string }[]; python?: unknown }>('/lib/index.json');
    return ok({ libs: index.libs.map((l) => ({ id: l.id, version: l.version, kind: l.kind, provides: l.provides, about: l.about })), python: index.python ?? null });
  }));
}
