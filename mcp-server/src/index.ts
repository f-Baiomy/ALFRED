import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

// stdio only: the server is reachable by nothing but the Claude session that started it (FR-020).
// stdout carries the protocol, so diagnostics go to stderr - ids and sizes, never call data.
const server = createServer();
await server.connect(new StdioServerTransport());
process.stderr.write(`alfred-mcp: ready (ALFRED_URL=${process.env['ALFRED_URL'] || 'http://localhost:3000'})\n`);
