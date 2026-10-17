import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredClient } from './alfred-client.ts';
import { registerSessionTool } from './session.ts';
import * as calls from './tools/calls.ts';
import * as comments from './tools/comments.ts';
import * as cycles from './tools/cycles.ts';
import * as db from './tools/db.ts';
import * as exportTool from './tools/export.ts';
import * as spacers from './tools/spacers.ts';
import * as watch from './tools/watch.ts';
import * as redactions from './tools/redactions.ts';
import * as cycleSearch from './tools/cycle-search.ts';
import * as diff from './tools/diff.ts';
import * as rulesRelive from './tools/rules-relive.ts';
import * as projects from './tools/projects.ts';
import * as triage from './tools/triage.ts';
import * as check from './tools/check.ts';
import * as task from './tools/task.ts';
import * as live from './tools/live.ts';
import * as logs from './tools/logs.ts';
import * as investigate from './tools/investigate.ts';
import * as redis from './tools/redis.ts';
import * as board from './tools/board.ts';
import * as boardVisuals from './tools/board-visuals.ts';
import * as requirements from './tools/requirements.ts';
import * as ruleProposals from './tools/rule-proposals.ts';
import * as chat from './tools/chat.ts';
import * as boards from './tools/boards.ts';
import * as team from './tools/team.ts';
import { withBoardParam } from './board-scope.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Builds the server with every tool registered - the stdio entry point and the tests share it. */
export function createServer(client: AlfredClient = new AlfredClient()): McpServer {
  const server = new McpServer({ name: 'alfred', version: pkg.version }, {
    instructions: 'Alfred records HTTP traffic in and out of a Java app (inbound = calls into a project such as odeysys; outbound = its supplier calls), '
      + 'the database statements each inbound call ran, and the log lines the application wrote during it (caught inside the JVM). '
      + 'Harness: a session cycle is a TASK and Alfred keeps its whole state. Start every session with task_context (no task lists them) - brief, '
      + 'requirements, findings, decisions, earlier runs, next step - and write progress back to the board, so any session, machine or agent can continue. '
      + 'Checking a cycle (listen, review): check_calls - every call in one pass, flagged ones with evidence, hop diffs between the calls of a flow; with sinceCallId per batch, wait_for_calls with settleSec between batches. '
      + 'Investigation order: problem_calls (every call with an error or warning - HTTP, database or logs) or triage (reading order with evidence) -> '
      + 'investigate_call on a suspect -> call_story / log_context (what happened just before the error) -> exception_source / locate_source (the line '
      + 'of code). Across calls: search_logs (who logged a symptom), log_problems (repeated errors grouped), endpoint_health, problem_timeline, '
      + 'compare_cycles. Drill into statements with db_overview / db_statements / db_statement. When lines are missing, each tool says why; you may '
      + 'turn ▤ log catching or ◆ database capture on, or change the Log level (set_log_capture, set_db_capture) when it helps - always tell the user '
      + 'what you changed (old -> new). Record findings with add_comment. Ask before writing exports. '
      + 'Task board: start a session with board_search (mine=true, status TO_DO/IN_PROGRESS) and board_changes (cursor "claude") to pick up '
      + 'where you left off; read a card with board_get (every comment in full) and its evidence with board_evidence. Before reporting, read '
      + 'board_closed_reasons, board_similar and board_for_call (and get_brief / read_spec for a cycle); add findings with board_add / '
      + 'board_add_many (they land in the Inbox for the user to sort), each with its teams (board_teams says what each team owns; '
      + 'one card can need several - one card, a short section per team), and reassign with board_assign when the evidence moves. Record progress with board_comment (did / found / next), answer with '
      + 'board_reply, ask with board_ask, record a fix with board_fix. Move cards only to To do, In progress or Fixed; Verified, Done and '
      + 'closing are the user\'s - propose them with board_propose, and suggest checklist marks with board_suggest_mark. After a re-test '
      + 'cycle run board_verify. Listen for the user with board_wait. Keep the live strip current with board_status. '
      + 'Board texts may be Markdown, HTML or both mixed - HTML is turned into board text (tables, callouts, colour), and HTML with script/style/SVG or animation into an html live snippet. Markdown by default; HTML only when Markdown cannot say it. '
      + 'Visuals: prefer fixed blocks (```stats, ```chart, ```calls with live data) in comments; a page or ```html live / ```python live '
      + 'snippet (board_page_put) only when they cannot say it - it runs locked, with no network, reading data through alfred.data. '
      + 'Check it with board_snippet_view before saying it is ready. Questions asked from the board arrive as /alfred-ask <id>. '
      + 'Interception rules: you only PROPOSE them (create_rule, saved off, narrow, never pausing) to reproduce a bug or check a fix - '
      + 'rule_recipes, rule_from_call and rule_preview first; the user switches them on, edits or deletes them; rule_hits shows what one did.',
  });
  registerSessionTool(server);
  for (const module of [cycles, spacers, calls, db, comments, exportTool, watch, redactions, cycleSearch, diff, rulesRelive, projects, triage, check, logs, investigate, redis, ruleProposals, boards, team]) module.register(server, client);
  // specs/027: the task tools also take `board` - a board is a task, its id the task key they always took
  const boarded = withBoardParam(server, client);
  for (const module of [task, board, boardVisuals, requirements, live, chat]) module.register(boarded, client);
  return server;
}
