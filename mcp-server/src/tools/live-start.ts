import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredClient } from '../alfred-client.ts';
import { fileLogger, LiveRunner, liveFiles } from '../live-runner.ts';
import { invalid, ok, run } from '../reply.ts';
import { beat } from './live.ts';

/**
 * live_start / live_stop / live_status (skills/alfred-live): start the /alfred-live runner as its own process - from
 * this server's own entry, so a checkout and a native install's bundle both work - and stop or inspect it. The runner
 * needs no model while it waits; each change of the user's gets one fresh `claude -p` run (live-runner.ts). Its log is
 * what the user's session watches (Monitor on `tail -F <log>`).
 */

interface Started { pid: number; log: string; project: string | null; cycleId: string | null; model: string | null; startedAt: string }
interface RunnerEnv { url: string; project?: string; cycleId?: string; model?: string; cwd: string; claude: string; mcpConfig: string; log: string; pidFile: string }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStarted(pidFile: string): Started | null {
  try {
    const s = JSON.parse(readFileSync(pidFile, 'utf8')) as Started;
    return alive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

function tail(path: string, lines: number): string[] {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

/**
 * This server's own entry, to start the runner and to give each run the Alfred tools: from source, index.ts through
 * this package's tsx; in a native install's bundle, the bundle file itself (this code is inside it).
 */
function selfCommand(): { command: string; args: string[] } {
  const here = import.meta.url;
  if (here.endsWith('.ts')) {
    return { command: process.execPath, args: [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', here)), fileURLToPath(new URL('../index.ts', here))] };
  }
  return { command: process.execPath, args: [fileURLToPath(here)] };
}

/** The runner process's main (index.ts calls it when ALFRED_LIVE_RUNNER is set). */
export async function runFromEnv(json: string): Promise<void> {
  const o = JSON.parse(json) as RunnerEnv;
  const runner = new LiveRunner({
    client: new AlfredClient(o.url), project: o.project, cycleId: o.cycleId, model: o.model, cwd: o.cwd, claude: o.claude,
    mcpConfig: o.mcpConfig, log: fileLogger(o.log),
  });
  const end = () => { runner.stop(); };
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
  // live_stop on Windows cannot signal a detached process gently: it removes the pid file, and the runner ends itself.
  const watch = setInterval(() => { if (!existsSync(o.pidFile)) end(); }, 2000);
  await runner.run();
  clearInterval(watch);
  process.exit(0);
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('live_start', {
    description: 'For /alfred-live: start the live runner for a project (and cycle) - a background process that waits on the board with no '
      + 'model running and answers each change of the user\'s with one fresh Claude run, showing every step on the card while it works. '
      + 'Returns the log file: watch it (Monitor, `tail -n 0 -F <log>`) so each event shows in the session. Already running → says so.',
    inputSchema: {
      project: z.string().optional().describe('One project; omit for every board'),
      cycleId: z.string().optional(),
      cwd: z.string().min(1).describe('The app\'s repo folder (the session\'s working folder) - the runs read the code there'),
      model: z.string().max(100).optional().describe('Only when the user named one; otherwise Claude Code\'s default model'),
      claude: z.string().max(500).default('claude').describe('The Claude Code command'),
    },
  }, (input) => run(async () => {
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw invalid(`${input.cwd} is not a folder on this machine.`);
    const files = liveFiles(client.baseUrl, input.project);
    const running = readStarted(files.pid);
    if (running) {
      return ok({ alreadyRunning: true, ...running, last: tail(running.log, 5), watch: `tail -n 0 -F "${running.log}"` });
    }
    const self = selfCommand();
    writeFileSync(files.mcp, JSON.stringify({ mcpServers: { alfred: { command: self.command, args: self.args,
      env: { ALFRED_URL: client.baseUrl, ALFRED_MCP_TRANSPORT: 'stdio' } } } }, null, 1));
    const env: RunnerEnv = { url: client.baseUrl, project: input.project, cycleId: input.cycleId, model: input.model, cwd: input.cwd,
      claude: input.claude, mcpConfig: files.mcp, log: files.log, pidFile: files.pid };
    writeFileSync(files.log, '');
    const child = spawn(self.command, self.args, {
      cwd: input.cwd, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ALFRED_LIVE_RUNNER: JSON.stringify(env), ALFRED_URL: client.baseUrl },
    });
    child.unref();
    const started: Started = { pid: child.pid ?? -1, log: files.log, project: input.project ?? null, cycleId: input.cycleId ?? null,
      model: input.model ?? null, startedAt: new Date().toISOString() };
    writeFileSync(files.pid, JSON.stringify(started));
    return ok({ started: true, ...started, watch: `tail -n 0 -F "${files.log}"`,
      model: input.model ?? 'Claude Code\'s default' });
  }));

  server.registerTool('live_stop', {
    description: 'For /alfred-live: stop the live runner of a project. It finishes or stops the answer in progress and ends.',
    inputSchema: { project: z.string().optional() },
  }, (input) => run(async () => {
    const files = liveFiles(client.baseUrl, input.project);
    const running = readStarted(files.pid);
    if (existsSync(files.pid)) unlinkSync(files.pid);
    beat(client.baseUrl, input.project ?? null, true);
    if (!running) return ok({ stopped: false, note: 'No live runner was running for this project.' });
    try { process.kill(running.pid, 'SIGTERM'); } catch { /* it ends itself once the pid file is gone */ }
    return ok({ stopped: true, pid: running.pid, last: tail(running.log, 5) });
  }));

  server.registerTool('live_status', {
    description: 'For /alfred-live: is the live runner running for a project, since when, and its last log lines.',
    inputSchema: { project: z.string().optional(), lines: z.number().int().min(1).max(200).default(20) },
  }, (input) => run(async () => {
    const files = liveFiles(client.baseUrl, input.project);
    const running = readStarted(files.pid);
    return ok({ running: !!running, ...(running ?? {}), log: files.log, last: tail(files.log, input.lines) });
  }));
}
