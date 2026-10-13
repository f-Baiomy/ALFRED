import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serveHttp } from './http.ts';
import { createServer } from './server.ts';

// Two transports (specs/012-server-program research R13):
// - stdio (default): the server is reachable by nothing but the Claude session that started it (FR-020 of 007).
//   stdout carries the protocol, so diagnostics go to stderr - ids and sizes, never call data.
// - http (ALFRED_MCP_TRANSPORT=http): the native install's supervisor runs this on 127.0.0.1 and the backend relays
//   /mcp to it, so Claude on another machine reaches Alfred's tools on the UI port. Never bound beyond loopback.
const transport = (process.env['ALFRED_MCP_TRANSPORT'] || 'stdio').toLowerCase();
const alfredUrl = process.env['ALFRED_URL'] || 'http://localhost:3000';

if (transport === 'http') {
  const { port } = await serveHttp(Number(process.env['ALFRED_MCP_PORT'] || 3009), () => createServer());
  process.stderr.write(`alfred-mcp: ready on http://127.0.0.1:${port}/mcp (ALFRED_URL=${alfredUrl})\n`);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`alfred-mcp: ready (ALFRED_URL=${alfredUrl})\n`);
}
