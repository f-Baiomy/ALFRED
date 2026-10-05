import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AlfredClient } from '../src/alfred-client.ts';
import { createServer } from '../src/server.ts';

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
  /** The reply parsed as JSON, or - for get_cycle's story - its trailing JSON line. */
  readonly json: any;
}

/** An MCP client connected in-process to a fresh server pointed at `baseUrl` (a fake Alfred, or the real one). */
export async function connect(baseUrl: string): Promise<{ call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>; close: () => Promise<void>; client: Client }> {
  const server = createServer(new AlfredClient(baseUrl));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'alfred-tests', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean };
      const text = result.content.map((c) => c.text).join('\n');
      return { text, isError: !!result.isError, json: parseJson(text) };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const last = text.trim().split('\n').pop() ?? '';
    try { return JSON.parse(last); } catch { return undefined; }
  }
}

import { FakeAlfred } from './fake-alfred.ts';
import { seed } from './fixtures.ts';
import { session } from '../src/session.ts';

/** A seeded fake Alfred plus a connected client; session settings reset for each test. */
export async function world(): Promise<{ fake: FakeAlfred; call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>; close: () => Promise<void> }> {
  const fake = await new FakeAlfred().start();
  seed(fake);
  session.maskSecrets = false;
  session.exportFolder = null;
  const h = await connect(fake.url);
  return { fake, call: h.call, close: async () => { await h.close(); await fake.stop(); } };
}
