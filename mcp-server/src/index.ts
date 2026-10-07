import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.ts';

// Two transports (specs/012-server-program research R13):
// - stdio (default): the server is reachable by nothing but the Claude session that started it (FR-020 of 007).
//   stdout carries the protocol, so diagnostics go to stderr - ids and sizes, never call data.
// - http (ALFRED_MCP_TRANSPORT=http): the native install's supervisor runs this on 127.0.0.1 and the backend relays
//   /mcp to it, so Claude on another machine reaches Alfred's tools on the UI port. Never bound beyond loopback.
const transport = (process.env['ALFRED_MCP_TRANSPORT'] || 'stdio').toLowerCase();
const alfredUrl = process.env['ALFRED_URL'] || 'http://localhost:3000';

/** Request bodies above this are refused (Constitution I: every client-supplied size is capped). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

if (transport === 'http') {
  await serveHttp(Number(process.env['ALFRED_MCP_PORT'] || 3009));
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`alfred-mcp: ready (ALFRED_URL=${alfredUrl})\n`);
}

async function serveHttp(port: number): Promise<void> {
  // One MCP server + transport per client session, as the SDK requires for Streamable HTTP.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http = createHttpServer(async (req, res) => {
    try {
      if (!(req.url || '').startsWith('/mcp')) {
        return reply(res, 404, 'not found');
      }
      const sessionId = header(req, 'mcp-session-id');
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const known = sessionId ? sessions.get(sessionId) : undefined;
      if (known) {
        await known.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'POST' && !sessionId && isInitializeRequest(body)) {
        const session: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => { sessions.set(id, session); },
        });
        session.onclose = () => {
          if (session.sessionId) {
            sessions.delete(session.sessionId);
          }
        };
        await createServer().connect(session);
        await session.handleRequest(req, res, body);
        return;
      }
      reply(res, 400, sessionId ? 'unknown or expired MCP session - reconnect' : 'expected an MCP initialize request');
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'too large';
      if (!res.headersSent) {
        reply(res, tooLarge ? 413 : 500, tooLarge ? `request body over ${MAX_BODY_BYTES} bytes` : 'internal error');
      }
      if (!tooLarge) {
        process.stderr.write(`alfred-mcp: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  });
  await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
  process.stderr.write(`alfred-mcp: ready on http://127.0.0.1:${port}/mcp (ALFRED_URL=${alfredUrl})\n`);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('too large');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}
