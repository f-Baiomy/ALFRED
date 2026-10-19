import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { AnswersFileError, checkAnswers, readAnswersFile, type AnswersJson } from '../answers-file.ts';
import { boardIdOf, type BoardSummaryRow } from '../board-ref.ts';
import { invalid, ok, run, type ToolReply } from '../reply.ts';
import { session } from '../session.ts';
import { resolveTarget } from './export.ts';

/**
 * The questions form and its answers file (specs/037, docs/board.md "Questions form"). Alfred builds the form and checks
 * and applies the answers; these tools only carry them: the form is saved where the user can send it, an answers file is
 * read on this machine and only its answers go to Alfred. Claude may make a form and dry-run an import on its own;
 * applying is the user's, so `dryRun: false` needs `askedIn` - the user's chat message on the board, or "terminal".
 */
const AS_CLAUDE = { 'X-Alfred-Actor': 'claude' } as const;
const MAX_IMAGE = 5 * 1024 * 1024;

const VERDICT_TEXT: Record<string, string> = {
  APPLY: 'will apply', APPLIED: 'applied', ALREADY_ANSWERED: 'already answered', CHANGED: 'question withdrawn or changed',
  UNKNOWN_KEY: 'unknown key', LATER: 'later - stays open', NOT_ANSWERED: 'not answered - stays open', REFUSED: 'refused',
};

interface ReportRow {
  q: string; card: number | null; header: string | null; question: string | null; choice: { id: string; label: string }[];
  other: boolean; later: boolean; note: string | null; sure: string | null; follow: { header: string; choice: { id: string; label: string }[] } | null;
  result: string; message: string | null;
}
interface Report {
  file: { formId: string; board: string; boardName: string | null; answeredBy: string; role: string; answeredAt: string | null; lang: string | null };
  rows: ReportRow[]; applied: number; summary: Record<string, number>; dryRun: boolean;
}

/** The report as lines Claude can show the user, each answer once. */
export function reportLines(r: Report): string[] {
  return r.rows.map((x) => {
    const said = [...x.choice.map((c) => c.label), ...(x.other ? ['Other answer'] : [])];
    const follow = x.follow && x.follow.choice.length ? ` → ${x.follow.header}: ${x.follow.choice.map((c) => c.label).join(', ')}` : '';
    const what = x.later ? 'later' : said.length ? said.join(', ') : x.note ? `"${x.note}"` : '-';
    return `${x.card != null ? `#${x.card} ` : ''}${x.header ?? x.q}: ${what}${follow}${x.note && said.length ? ` (note: ${x.note})` : ''}`
      + `${x.sure ? ` [${x.sure}]` : ''} - ${VERDICT_TEXT[x.result] ?? x.result}${x.message ? ` (${x.message})` : ''}`;
  });
}

function magicType(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_questions_form', {
    description: 'Make a questions form for someone outside Alfred (a BA, a product owner, another team): one self-contained HTML file '
      + 'with the board\'s open questions - all of them, or those of `cards` - their options, the recommended one, the details (screenshots, '
      + 'charts, tables embedded), in Arabic or English (auto: the language most questions are in). They open it offline, answer, and '
      + 'download an answers file (also .html) to send back; board_import_answers reads it. Alfred builds the file and masks it; this saves '
      + 'it (`path`, else the session export folder, else a temp folder) and says where. `format: "zip"` for mail that blocks .html. '
      + 'Yours to do on your own - it changes nothing on the cards.',
    inputSchema: {
      board: z.string().min(1).max(200).describe('AB#<item id>, the board name or its id'),
      cards: z.array(z.number().int().min(1)).max(200).optional().describe('Card numbers - default: every card with open questions'),
      lang: z.enum(['auto', 'ar', 'en']).default('auto'),
      title: z.string().max(200).optional(),
      format: z.enum(['html', 'zip']).default('html'),
      path: z.string().min(1).optional().describe('Where to save: an absolute path, or a file name in the export folder'),
    },
  }, (input) => run(async () => {
    const boardId = await boardIdOf(client, input.board);
    const r = await client.binary('POST', `/board/boards/${seg(boardId)}/questions-form`, {
      headers: AS_CLAUDE, body: { cards: input.cards ?? [], lang: input.lang, title: input.title, format: input.format }, timeoutMs: 120_000,
    });
    const name = decodeURIComponent(r.headers.get('x-alfred-form-name') ?? '') || `questions.${input.format}`;
    let target = resolveTarget(input.path, name);
    if ('refused' in target) throw invalid(target.refused);
    if ('needsPath' in target) target = { path: join(tmpdir(), 'alfred-forms', name) };
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, r.data);
    const leftOut = decodeURIComponent(r.headers.get('x-alfred-form-left-out') ?? '');
    const warning = decodeURIComponent(r.headers.get('x-alfred-form-warning') ?? '');
    return ok({
      saved: target.path, formId: r.headers.get('x-alfred-form-id'), questions: Number(r.headers.get('x-alfred-form-questions') ?? 0),
      cards: (r.headers.get('x-alfred-form-cards') ?? '').split(',').filter(Boolean).map((n) => `#${n}`),
      size: `${Math.max(1, Math.round(r.data.length / 1024))} KB`,
      ...(leftOut ? { leftOut: leftOut.split('\n') } : {}), ...(warning ? { warning } : {}),
      next: 'Tell the user where the file is so they can send it. When the answers file comes back, board_import_answers reads it.',
    });
  }));

  server.registerTool('board_import_answers', {
    description: 'Read an answers file someone filled in a questions form (.html, or a .zip holding it) and check it against the board: '
      + 'each answer will apply, is already answered, was withdrawn or changed, has an unknown key, or stays open (later / not answered). '
      + 'Give `path` (read on this machine - only the answers go to Alfred, never the page), `fileId` (a file stored on the board) or '
      + '`text` (the page itself). dryRun (default true) changes nothing: show the user the report and ask. Only when the user says to '
      + 'apply, call again with dryRun: false and askedIn = the id of their chat message on the board, or "terminal" when they said it '
      + 'here; each answer is then recorded on its card as the user\'s ("from answers file by <name>"), which board_wait / alfred-live see '
      + 'as ordinary answers. `attach: true` also keeps the file on the board.',
    inputSchema: {
      path: z.string().min(1).optional(), fileId: z.string().min(8).max(64).optional(), text: z.string().min(1).max(2 * 1024 * 1024).optional(),
      board: z.string().min(1).max(200).optional().describe('AB#<item id>, name or id - default: the board the form was made for'),
      dryRun: z.boolean().default(true),
      askedIn: z.string().max(40).optional().describe('With dryRun false: the user\'s chat message id, or "terminal"'),
      attach: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    const given = [input.path, input.fileId, input.text].filter((v) => v !== undefined).length;
    if (given !== 1) throw invalid('Give exactly one of path, fileId or text.');
    if (!input.dryRun && !input.askedIn) {
      throw invalid('Applying answers is the user\'s. Show them the dry run first; when they say yes, call again with askedIn: their chat '
        + 'message id on the board, or "terminal" if they said it here.');
    }
    let answers: AnswersJson | null = null;
    let fileBytes: Buffer | null = null;
    let fileName = 'answers.html';
    try {
      if (input.path) {
        const full = resolve(isAbsolute(input.path) ? input.path : join(session.exportFolder ?? process.cwd(), input.path));
        const info = await stat(full).catch(() => null);
        if (!info?.isFile()) throw invalid(`No file at ${full}`);
        if (info.size > 2 * 1024 * 1024) throw invalid('An answers file is at most 2 MB');
        fileBytes = await readFile(full);
        fileName = basename(full);
        answers = readAnswersFile(fileName, fileBytes);
      } else if (input.text) {
        answers = readAnswersFile('answers.html', Buffer.from(input.text, 'utf8'));
        fileBytes = Buffer.from(input.text, 'utf8');
      }
    } catch (e) {
      if (e instanceof AnswersFileError) throw invalid(e.message);
      throw e;
    }
    const boardId = input.board ? await boardIdOf(client, input.board) : (answers?.board as string | undefined) ?? '';
    if (!boardId && !input.fileId) throw invalid('This answers file names no board - pass board.');
    if (input.attach && fileBytes) {
      const summary = await client.get<BoardSummaryRow>(`/board/boards/${seg(boardId)}`);
      await client.binary('POST', '/board/files', { headers: AS_CLAUDE, query: { cycle: boardId, project: summary.board.project, name: fileName },
        bytes: fileBytes, contentType: 'application/octet-stream' });
    }
    const body = input.fileId ? { fileId: input.fileId, dryRun: input.dryRun, askedIn: input.askedIn }
      : { answers: checkAnswers(answers), dryRun: input.dryRun, askedIn: input.askedIn };
    const path = input.fileId && !boardId ? null : `/board/boards/${seg(boardId)}/answers-import`;
    const report = path
      ? await client.post<Report>(path, { headers: AS_CLAUDE, body, timeoutMs: 60_000 })
      : await client.get<Report>(`/board/files/${seg(input.fileId!)}/answers.json`);
    const f = report.file;
    return ok({
      file: `${f.answeredBy || 'someone'}${f.role ? ` (${f.role})` : ''}${f.answeredAt ? `, ${f.answeredAt}` : ''} - board ${f.boardName ?? f.board}`,
      dryRun: report.dryRun, applied: report.applied, summary: report.summary, answers: reportLines(report),
      next: report.dryRun ? 'Show the user these lines and ask whether to apply them; apply only on their yes (dryRun: false, askedIn).'
        : 'The answers are on the cards as the user\'s; act on them as on any answer (board_changes / board_wait).',
      json: report,
    });
  }));

  server.registerTool('board_image_put', {
    description: 'Put a picture on the board - a screenshot you took (browser, app window) or a file on disk - and get the '
      + '![alt](/board/images/<id>) to use in a question\'s details, a comment or a description. PNG, JPEG, GIF or WebP, at most 5 MB. '
      + 'Pictures are not masked: crop or blur anything secret (tokens, passwords, personal data) before putting it here.',
    inputSchema: {
      path: z.string().min(1).optional().describe('An absolute path to the picture'),
      base64: z.string().min(16).max(8 * 1024 * 1024).optional().describe('Or the picture itself, base64'),
      name: z.string().max(120).optional().describe('What it shows - the alt text'),
    },
  }, (input) => run(async (): Promise<ToolReply> => {
    if (!input.path === !input.base64) throw invalid('Give path or base64.');
    let data: Buffer;
    if (input.path) {
      if (!isAbsolute(input.path)) throw invalid('path must be absolute');
      const info = await stat(input.path).catch(() => null);
      if (!info?.isFile()) throw invalid(`No file at ${input.path}`);
      if (info.size > MAX_IMAGE) throw invalid('A picture is at most 5 MB - crop or scale it down');
      data = await readFile(input.path);
    } else {
      data = Buffer.from(input.base64!.replace(/^data:[^,]*,/, ''), 'base64');
    }
    if (data.length > MAX_IMAGE) throw invalid('A picture is at most 5 MB - crop or scale it down');
    const type = magicType(data);
    if (!type) throw invalid('That is not a PNG, JPEG, GIF or WebP picture.');
    const r = await client.binary('POST', '/board/images', { headers: AS_CLAUDE, bytes: data, contentType: type });
    const saved = JSON.parse(r.data.toString('utf8')) as { id: string; url: string };
    const alt = (input.name ?? (input.path ? basename(input.path) : 'screenshot')).replace(/[[\]]/g, '');
    return ok({ url: saved.url, markdown: `![${alt}](${saved.url})`,
      note: 'Pictures are not masked - you checked no secret is on it. Put the markdown in a question\'s details (board_ask) or a comment.' });
  }));
}
