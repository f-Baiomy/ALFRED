import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { invalid, ok, run } from '../reply.ts';

/**
 * The projects Alfred fronts, and the switches that decide what it records for each: inbound logging (the reverse
 * proxy logs calls into the project), database capture ◆ (the db-agent records each inbound call's statements), log
 * catching ▤ and its Log level (the agent catches the application's log lines). Inbound logging refuses to change
 * without confirm: true. ◆, ▤ and the Log level Claude may change when an investigation needs it (the owner's decision,
 * specs/010) - every reply says what changed, old and new. None changes what the application itself does.
 */

interface InboundService { name: string; listenPort: number | null; upstreamPort: number | null; enabled: boolean }
interface CaptureProject {
  project: string; enabled: boolean; inboundLogging: boolean; attached: boolean; logsOn?: boolean; logLevel?: string;
  agent?: { agentVersion?: string; lastSeen?: string } | null;
}

async function projects(client: AlfredClient) {
  const [feature, services, capture] = await Promise.all([
    client.get<{ enabled: boolean }>('/internal-calls/feature-enabled'),
    client.get<InboundService[]>('/internal-calls/services'),
    client.get<CaptureProject[]>('/db-capture/projects').catch(() => [] as CaptureProject[]),
  ]);
  return {
    inboundLoggingAvailable: feature.enabled,
    projects: services
      // 'unknown' is the bucket for calls whose project could not be told - not a project to switch.
      .filter((s) => s.listenPort !== null)
      .map((s) => {
        const db = capture.find((c) => c.project === s.name);
        return {
          name: s.name, listenPort: s.listenPort, upstreamPort: s.upstreamPort, inboundLogging: s.enabled,
          dbCapture: db ? { enabled: db.enabled, agentAttached: db.attached, ...(db.agent?.lastSeen ? { agentLastSeen: db.agent.lastSeen } : {}) } : null,
          logCatching: db ? { on: !!db.logsOn, logLevel: db.logLevel ?? 'ERROR' } : null,
        };
      }),
  };
}

async function requireProject(client: AlfredClient, name: string) {
  const all = await projects(client);
  const project = all.projects.find((p) => p.name === name);
  if (!project) throw invalid(`No project "${name}". Projects: ${all.projects.map((p) => p.name).join(', ') || 'none'}.`);
  return project;
}

const ConfirmSchema = z.boolean().default(false)
  .describe('Must be true to act. This changes what Alfred records for everyone using it - ask the user first, then pass true.');

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('list_projects', {
    description: 'The projects Alfred fronts (e.g. odeysys) with their listen ports, whether inbound calls are being logged, and whether '
      + 'database capture is on and its agent attached.',
    inputSchema: {},
  }, () => run(async () => ok(await projects(client))));

  server.registerTool('set_inbound_logging', {
    description: 'Turn logging of a project\'s inbound calls on or off (from the next call on; nothing already recorded changes). '
      + 'Changes Alfred for everyone: without confirm: true it only says what would happen.',
    inputSchema: { project: z.string().min(1), enabled: z.boolean(), confirm: ConfirmSchema },
  }, (input) => run(async () => {
    const project = await requireProject(client, input.project);
    if (project.inboundLogging === input.enabled) return ok({ project: project.name, inboundLogging: input.enabled, changed: false });
    if (!input.confirm) {
      return ok({
        needsConfirm: true,
        effect: input.enabled
          ? `Alfred will start logging inbound calls into ${project.name} (port ${project.listenPort}).`
          : `Alfred will stop logging inbound calls into ${project.name}; database capture for it stops recording too, and cycles stop receiving its calls.`,
        next: 'Ask the user; if they agree, call again with confirm: true.',
      });
    }
    await client.post(`/internal-calls/services/${seg(project.name)}/logging-enabled`, { body: { enabled: input.enabled } });
    const after = await requireProject(client, project.name);
    return ok({ project: after.name, inboundLogging: after.inboundLogging, changed: true });
  }));

  server.registerTool('set_db_capture', {
    description: 'Turn database capture ◆ for a project on or off (needs its inbound logging on, and the db-agent loaded in the app - see '
      + 'list_projects). You may do this when an investigation needs statements; tell the user what you changed (the reply says old and new).',
    inputSchema: { project: z.string().min(1), enabled: z.boolean() },
  }, (input) => run(async () => {
    const project = await requireProject(client, input.project);
    const was = project.dbCapture?.enabled ?? false;
    if (was === input.enabled) return ok({ project: project.name, dbCapture: project.dbCapture, changed: [] });
    if (input.enabled && !project.inboundLogging) {
      throw invalid(`Inbound logging is off for ${project.name}; statements attach to inbound calls, so turn that on first (set_inbound_logging).`);
    }
    await client.put(`/db-capture/projects/${seg(project.name)}/enabled`, { body: { enabled: input.enabled } });
    const after = await requireProject(client, project.name);
    return ok({
      project: after.name, dbCapture: after.dbCapture, changed: [{ setting: 'dbCapture', from: was, to: input.enabled }],
      ...(input.enabled && !after.dbCapture?.agentAttached ? { note: 'No agent is attached yet: nothing is recorded until the db-agent is loaded (python3 start.py --db-capture on).' } : {}),
      tellTheUser: true,
    });
  }));

  server.registerTool('set_log_capture', {
    description: 'Turn log catching ▤ for a project on or off, and/or set its Log level - the lowest level of line the agent catches with each call: '
      + 'ERROR (the default), WARN, INFO, DEBUG, TRACE or APP (whatever the application itself writes). It cannot go below the application level '
      + 'level. Takes effect within about 10 s, for calls from then on - earlier calls keep what they had. You may do this when an investigation '
      + 'needs more detail; tell the user what you changed (the reply says old and new).',
    inputSchema: {
      project: z.string().min(1),
      on: z.boolean().optional(),
      level: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'APP']).optional(),
    },
  }, (input) => run(async () => {
    if (input.on === undefined && !input.level) throw invalid('Say what to change: on and/or level.');
    const project = await requireProject(client, input.project);
    const changed: { setting: string; from: unknown; to: unknown }[] = [];
    const wasOn = project.logCatching?.on ?? false;
    if (input.on !== undefined && input.on !== wasOn) {
      if (input.on && !project.inboundLogging) {
        throw invalid(`Inbound logging is off for ${project.name}; log lines attach to inbound calls, so turn that on first (set_inbound_logging).`);
      }
      await client.put(`/db-capture/projects/${seg(project.name)}/logs`, { body: { on: input.on } });
      changed.push({ setting: 'logCatching', from: wasOn, to: input.on });
    }
    if (input.level) {
      const settings = await client.get<Record<string, unknown>>(`/db-capture/projects/${seg(project.name)}/settings`);
      const wasLevel = (settings['logLevel'] as string | undefined) ?? 'ERROR';
      if (wasLevel !== input.level) {
        await client.put(`/db-capture/projects/${seg(project.name)}/settings`, { body: { ...settings, logLevel: input.level } });
        changed.push({ setting: 'logLevel', from: wasLevel, to: input.level });
      }
    }
    const after = await requireProject(client, project.name);
    return ok({
      project: after.name, logCatching: after.logCatching, changed,
      ...(changed.length ? { note: 'Applies to calls from now on (the agent picks it up within ~10 s); calls already recorded keep the lines they had.', tellTheUser: true } : {}),
      ...(after.logCatching?.on && !after.dbCapture?.agentAttached ? { warning: 'No agent is attached to this project: no lines are caught until the db-agent is loaded.' } : {}),
    });
  }));
}
