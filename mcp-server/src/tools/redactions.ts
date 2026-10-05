import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import type { Redaction } from '../frontend.ts';
import { ok, run } from '../reply.ts';

/**
 * The secrets travel suppliers' traffic always carries: auth headers, API keys and SOAP/form
 * passwords. Created as ordinary Alfred Redactions (scope "all") - visible and removable in the UI's
 * Settings, applied to every export (UI and MCP) and, when masking is on, to replies. Body keys
 * match JSON keys, XML elements/attributes by local name (wsse:Password) and form fields alike.
 */
export const DEFAULT_REDACTIONS: readonly { kind: Redaction['kind']; name: string }[] = [
  { kind: 'request-header', name: 'Authorization' },
  { kind: 'request-header', name: 'Proxy-Authorization' },
  { kind: 'request-header', name: 'Cookie' },
  { kind: 'response-header', name: 'Set-Cookie' },
  { kind: 'request-header', name: 'x-api-key' },
  { kind: 'request-body-key', name: 'password' },
  { kind: 'request-body-key', name: 'apiKey' },
  { kind: 'request-body-key', name: 'api_key' },
  { kind: 'request-body-key', name: 'client_secret' },
  { kind: 'response-body-key', name: 'access_token' },
  { kind: 'response-body-key', name: 'refresh_token' },
  { kind: 'url-param', name: 'password' },
  { kind: 'url-param', name: 'apiKey' },
];

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('add_default_redactions', {
    description: 'Add Alfred\'s standard redaction rules (Authorization, Cookie, x-api-key, password incl. SOAP wsse:Password and form fields, '
      + 'apiKey, tokens) as global Redactions - only the ones missing. They then mask every export, and replies when masking is on. '
      + 'This changes Alfred\'s settings for everyone using it: ask the user first. dryRun lists what would be added.',
    inputSchema: { dryRun: z.boolean().default(false) },
  }, (input) => run(async () => {
    const existing = await client.get<Redaction[]>('/redactions');
    const has = (kind: string, name: string) => existing.some((r) => r.scope === 'all' && r.kind === kind && r.name.toLowerCase() === name.toLowerCase());
    const missing = DEFAULT_REDACTIONS.filter((d) => !has(d.kind, d.name));
    if (!input.dryRun) {
      for (const d of missing) await client.post('/redactions', { body: { scope: 'all', callId: null, kind: d.kind, name: d.name } });
    }
    return ok({ added: input.dryRun ? [] : missing, wouldAdd: input.dryRun ? missing : undefined, alreadyPresent: DEFAULT_REDACTIONS.length - missing.length });
  }));
}
