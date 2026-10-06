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
import { registerPrompts } from './prompts.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Builds the server with every tool registered - the stdio entry point and the tests share it. */
export function createServer(client: AlfredClient = new AlfredClient()): McpServer {
  const server = new McpServer({ name: 'alfred', version: pkg.version }, {
    instructions: 'Alfred records HTTP traffic in and out of a Java app (inbound = calls into a project such as odeysys; outbound = its supplier calls) '
      + 'and the database statements each inbound call ran. Start debugging with triage (what needs attention first, with evidence) and get_cycle, drill in with get_call and db_overview / '
      + 'db_statements / db_statement (callers name the source file and line), record findings with add_comment. Ask before writing exports.',
  });
  registerSessionTool(server);
  for (const module of [cycles, spacers, calls, db, comments, exportTool, watch, redactions, cycleSearch, diff, rulesRelive, projects, triage, logs]) module.register(server, client);
  registerPrompts(server);
  return server;
}
