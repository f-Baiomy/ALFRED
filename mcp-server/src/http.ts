import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/** Request bodies above this are refused (Constitution I: every client-supplied size is capped). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * The Streamable HTTP transport (specs/012-server-program research R13): one MCP server + transport per client
 * session, as the SDK requires, on 127.0.0.1 only - the backend relays /mcp to it. {@code port} 0 picks a free port
 * (the tests' HTTP run).
 */
export async function serveHttp(port: number, makeServer: () => McpServer): Promise<{ port: number; close: () => Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const http: Server = createHttpServer(async (req, res) => {
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
        await makeServer().connect(session);
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
  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      await Promise.all([...sessions.values()].map(s => s.close().catch(() => undefined)));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
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
