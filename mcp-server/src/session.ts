import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { invalid, ok, run } from './reply.ts';

/**
 * Settings for this Claude session. The server process lives exactly as long as the session that
 * started it, so in-memory IS session scope - nothing is ever written to disk (FR-017e/f).
 */
export interface SessionSettings {
  maskSecrets: boolean;
  exportFolder: string | null;
  /** The project whose source files call-chain frames resolve to - the folder Claude Code started this server in. */
  sourceRoot: string;
}

export const session: SessionSettings = {
  maskSecrets: process.env['ALFRED_MCP_MASK'] === '1',
  exportFolder: null,
  sourceRoot: process.env['ALFRED_SOURCE_ROOT'] || process.cwd(),
};

export function registerSessionTool(server: McpServer): void {
  server.registerTool('session_settings', {
    description: 'Show or change this session\'s Alfred settings. maskSecrets: hide values matched by Alfred\'s Redactions and secret '
      + 'variables in every tool reply (with it off, recorded bodies, headers, tokens and DB rows are returned verbatim and reach the '
      + 'model provider). exportFolder: default folder for export_calls when no path or a relative path is given (null clears it; '
      + 'without it, exports ask where to save). sourceRoot: the project folder call-chain frames (File.java:line) are resolved '
      + 'against - by default the folder Claude Code started this server in. Change these only when the user asks. '
      + 'Call with no arguments to read the current values.',
    inputSchema: {
      maskSecrets: z.boolean().optional(),
      exportFolder: z.string().min(1).nullable().optional(),
      sourceRoot: z.string().min(1).optional(),
    },
  }, (input) => run(async () => {
    if (input.exportFolder !== undefined) {
      if (input.exportFolder === null) {
        session.exportFolder = null;
      } else {
        const folder = resolve(input.exportFolder);
        const info = await stat(folder).catch(() => null);
        if (!info?.isDirectory()) throw invalid(`Not an existing folder: ${folder}`);
        session.exportFolder = folder;
      }
    }
    if (input.sourceRoot !== undefined) {
      const folder = resolve(input.sourceRoot);
      const info = await stat(folder).catch(() => null);
      if (!info?.isDirectory()) throw invalid(`Not an existing folder: ${folder}`);
      session.sourceRoot = folder;
    }
    if (input.maskSecrets !== undefined) session.maskSecrets = input.maskSecrets;
    return ok({ maskSecrets: session.maskSecrets, exportFolder: session.exportFolder, sourceRoot: session.sourceRoot });
  }));
}
