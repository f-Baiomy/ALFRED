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
import * as logs from './tools/logs.ts';
import * as investigate from './tools/investigate.ts';
import { registerPrompts } from './prompts.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Builds the server with every tool registered - the stdio entry point and the tests share it. */
export function createServer(client: AlfredClient = new AlfredClient()): McpServer {
  const server = new McpServer({ name: 'alfred', version: pkg.version }, {
    instructions: 'Alfred records HTTP traffic in and out of a Java app (inbound = calls into a project such as odeysys; outbound = its supplier calls), '
      + 'the database statements each inbound call ran, and the log lines the application wrote during it (caught inside the JVM). '
      + 'Investigation order: problem_calls (every call with an error or warning - HTTP, database or logs) or triage (reading order with evidence) -> '
      + 'investigate_call on a suspect -> call_story / log_context (what happened just before the error) -> exception_source / locate_source (the line '
      + 'of code). Across calls: search_logs (who logged a symptom), log_problems (repeated errors grouped), endpoint_health, problem_timeline, '
      + 'compare_cycles. Drill into statements with db_overview / db_statements / db_statement. When lines are missing, each tool says why; you may '
      + 'turn ▤ log catching or ◆ database capture on, or change the Log level (set_log_capture, set_db_capture) when it helps - always tell the user '
      + 'what you changed (old -> new). Record findings with add_comment. Ask before writing exports.',
  });
  registerSessionTool(server);
  for (const module of [cycles, spacers, calls, db, comments, exportTool, watch, redactions, cycleSearch, diff, rulesRelive, projects, triage, logs, investigate]) module.register(server, client);
  registerPrompts(server);
  return server;
}
