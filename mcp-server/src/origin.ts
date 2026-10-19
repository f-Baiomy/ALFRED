import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from './alfred-client.ts';
import { splitRef } from './tools/links.ts';
import type { ToolReply } from './reply.ts';

type Handler = (input: Record<string, unknown>, extra: unknown) => unknown;

interface LinkRow {
  readonly slug: string;
  readonly name: string;
  readonly online: boolean;
}

/** How long the list of links is trusted: a link is renamed or added rarely, and a stale name only labels. */
const LINKS_TTL_MS = 30_000;

/** The links named by the tags (`@<tag>`) at the end of the ids in a tool's input, outermost first. */
export function tagsIn(input: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 3 || input === null || input === undefined) return out;
  if (typeof input === 'string') {
    const s = splitRef(input);
    if (s) out.add(s.slug);
  } else if (Array.isArray(input)) {
    for (const v of input.slice(0, 200)) tagsIn(v, out, depth + 1);
  } else if (typeof input === 'object') {
    for (const v of Object.values(input as Record<string, unknown>)) tagsIn(v, out, depth + 1);
  }
  return out;
}

/**
 * specs/035: a reply about another Alfred's cycle, board, card or call opens with where it came from - that Alfred's
 * name, whether it is online, and that its things are read only here - so Claude never takes it for this Alfred's own
 * or tries to change it. The rest of the reply is unchanged. The links and env tools speak of other Alfreds already.
 */
export function withOrigins(server: McpServer, client: AlfredClient): McpServer {
  let cache: { at: number; links: readonly LinkRow[] } | null = null;
  const links = async (): Promise<readonly LinkRow[]> => {
    if (!cache || Date.now() - cache.at > LINKS_TTL_MS) {
      let rows: readonly LinkRow[] = [];
      try {
        rows = await client.get<LinkRow[]>('/links');
      } catch {
        // no links here (an older Alfred, or the tunnel): nothing to label
      }
      cache = { at: Date.now(), links: Array.isArray(rows) ? rows : [] };
    }
    return cache.links;
  };
  const register = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, handler: Handler) => unknown;
  const wrapped = (name: string, config: Record<string, unknown>, handler: Handler): unknown => {
    if (name.startsWith('links_') || name.startsWith('env_')) return register(name, config, handler);
    return register(name, config, async (input, extra) => {
      const reply = (await handler(input, extra)) as ToolReply;
      const tags = tagsIn(input);
      if (tags.size === 0 || !reply?.content?.length || reply.content[0].type !== 'text') return reply;
      const named = (await links()).filter((l) => tags.has(l.slug));
      if (named.length === 0) return reply;
      const label = named.map((l) => `${l.name}${l.online ? '' : ' (offline)'}`).join(', ');
      const first = `⇇ From ${label} - another Alfred's, streamed here: read only on this Alfred; ask its owner with links_request.`;
      return { ...reply, content: [{ type: 'text' as const, text: `${first}\n\n${reply.content[0].text}` }, ...reply.content.slice(1)] };
    });
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      return prop === 'registerTool' ? wrapped : Reflect.get(target, prop, receiver);
    },
  });
}
