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

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Builds the server with every tool registered - the stdio entry point and the tests share it. */
export function createServer(client: AlfredClient = new AlfredClient()): McpServer {
  const server = new McpServer({ name: 'alfred', version: pkg.version }, {
    instructions: 'Alfred records HTTP traffic in and out of a Java app (inbound = calls into a project such as odeysys; outbound = its supplier calls) '
      + 'and the database statements each inbound call ran. Start debugging with list_cycles / get_cycle, drill in with get_call and db_overview / '
      + 'db_statements / db_statement (callers name the source file and line), record findings with add_comment. Ask before writing exports.',
  });
  registerSessionTool(server);
  for (const module of [cycles, spacers, calls, db, comments, exportTool]) module.register(server, client);
  return server;
}
