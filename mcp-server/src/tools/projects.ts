import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { invalid, ok, run } from '../reply.ts';

/**
 * The projects Alfred fronts, and the two switches that decide what it records for each: inbound
 * logging (the reverse proxy logs calls into the project) and database capture (the db-agent records
 * each inbound call's statements). Flipping either changes what Alfred records from the next call on,
 * for everyone using it - so both refuse to act without confirm: true, which Claude passes only after
 * the user said yes. Neither changes what the application itself does.
 */

interface InboundService { name: string; listenPort: number | null; upstreamPort: number | null; enabled: boolean }
interface CaptureProject { project: string; enabled: boolean; inboundLogging: boolean; attached: boolean; agent?: { agentVersion?: string; lastSeen?: string } | null }

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
    description: 'Turn database capture for a project on or off (needs its inbound logging on, and the db-agent loaded in the app - see '
      + 'list_projects). Changes Alfred for everyone: without confirm: true it only says what would happen.',
    inputSchema: { project: z.string().min(1), enabled: z.boolean(), confirm: ConfirmSchema },
  }, (input) => run(async () => {
    const project = await requireProject(client, input.project);
    if (project.dbCapture?.enabled === input.enabled) return ok({ project: project.name, dbCapture: project.dbCapture, changed: false });
    if (input.enabled && !project.inboundLogging) {
      throw invalid(`Inbound logging is off for ${project.name}; statements attach to inbound calls, so turn that on first (set_inbound_logging).`);
    }
    if (!input.confirm) {
      return ok({
        needsConfirm: true,
        effect: input.enabled
          ? `Alfred will record the database statements of every inbound call into ${project.name}${project.dbCapture?.agentAttached ? '' : ' - but no agent is attached yet, so nothing is recorded until the db-agent is loaded (python3 start.py --db-capture on)'}.`
          : `Alfred will stop recording database statements for ${project.name}; captures already recorded stay.`,
        next: 'Ask the user; if they agree, call again with confirm: true.',
      });
    }
    await client.put(`/db-capture/projects/${seg(project.name)}/enabled`, { body: { enabled: input.enabled } });
    const after = await requireProject(client, project.name);
    return ok({ project: after.name, dbCapture: after.dbCapture, changed: true });
  }));
}
