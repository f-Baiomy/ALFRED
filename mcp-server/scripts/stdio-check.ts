/** Starts the server as `claude mcp add` registers it (node + tsx; --npm for the npm script) from another folder, and calls a tool over real stdio. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const prefix = fileURLToPath(new URL('..', import.meta.url));
const viaNpm = process.argv.includes('--npm');
const transport = new StdioClientTransport(viaNpm
  ? { command: 'npm', args: ['--prefix', prefix, 'run', '--silent', 'start'], stderr: 'pipe' }
  : { command: process.execPath, args: [`${prefix}node_modules/tsx/dist/cli.mjs`, `${prefix}src/index.ts`], stderr: 'pipe', cwd: process.env['TEMP'] ?? '/' });
const client = new Client({ name: 'stdio-check', version: '0' });
const started = Date.now();
await client.connect(transport);
const tools = await client.listTools();
const r = await client.callTool({ name: 'list_cycles', arguments: { nameContains: 'zzz-no-match' } }) as { content: { text: string }[] };
process.stdout.write(`connected in ${Date.now() - started} ms; ${tools.tools.length} tools; list_cycles -> ${r.content[0].text}\n`);
await client.close();
