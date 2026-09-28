import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CallEndpointSource, CallRecord } from '../models/call.model';
import { CallRef, PickedCall } from '../models/call-ref.model';
import { CallsQuery } from '../state/call-list-view';
import { buildCallTree, CallTreeNode } from '../../shared/utils/call-tree';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';
import { CallsApiService } from './calls-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

const PAGE_SIZE = 200;

@Injectable({ providedIn: 'root' })
export class ReliveCallSourceService {
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly live = inject(CallsApiService);

  async loadCycle(cycleId: string): Promise<CallRecord[]> {
    const [inbound, outbound] = await Promise.all([
      this.loadDirection(cycleId, 'internal'),
      this.loadDirection(cycleId, 'external'),
    ]);
    return [...inbound, ...outbound].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private async loadDirection(cycleId: string, source: CallEndpointSource): Promise<CallRecord[]> {
    const calls: CallRecord[] = [];
    const seen = new Set<string>();
    let offset = 0;
    while (true) {
      const query: CallsQuery = { search: '', supplier: '', sort: 'oldest', offset, limit: PAGE_SIZE, sessionId: '', operationId: '', requestId: '' };
      const page = await firstValueFrom(this.cycles.listCalls(cycleId, query, source, undefined, true));
      const fresh = page.calls.map((captured) => captured.call).filter((call) => !seen.has(call.id));
      if (page.calls.length && !fresh.length) throw new Error('The session-cycle API did not advance to the next page.');
      for (const call of fresh) seen.add(call.id);
      calls.push(...fresh);
      if (page.calls.length === 0 || calls.length >= page.total) return calls;
      offset += page.calls.length;
    }
  }

  async hydrate(calls: readonly CallRecord[], cycleId: string | null): Promise<CallRecord[]> {
    const result: CallRecord[] = [];
    for (let i = 0; i < calls.length; i += 8) {
      const batch = await Promise.all(calls.slice(i, i + 8).map(async (call) => {
        const source = call.source ?? 'external';
        const detail = cycleId === null
          ? await firstValueFrom(this.live.getDetail(call.id, source))
          : await firstValueFrom(this.cycles.getDetail(cycleId, call.id, source));
        return { ...call, ...detail };
      }));
      result.push(...batch);
    }
    return result;
  }

  /** One picked root keeps its own origin; children are discovered from the same source. */
  async freezePicked(picked: readonly PickedCall[], settings: ReliveSettings): Promise<Step[]> {
    const cycleCache = new Map<string, Promise<CallRecord[]>>();
    const steps: Step[] = [];
    const added = new Set<string>();
    for (const pick of picked) {
      const ref = pick.ref;
      const key = `${ref.cycleId ?? 'live'}:${ref.source}:${ref.callId}`;
      if (added.has(key)) continue;
      let calls: CallRecord[] = [pick.call];
      if (ref.source === 'internal') {
        let available: CallRecord[];
        if (ref.cycleId) {
          if (!cycleCache.has(ref.cycleId)) cycleCache.set(ref.cycleId, this.loadCycle(ref.cycleId));
          available = await cycleCache.get(ref.cycleId)!;
        } else {
          available = await this.loadLiveOverlaps(pick.call);
        }
        const node = findNode(buildCallTree(available), ref.callId);
        if (node) calls = flattenNode(node);
      }
      const unique = calls.filter((call) => {
        const callKey = `${ref.cycleId ?? 'live'}:${call.source ?? 'external'}:${call.id}`;
        if (added.has(callKey)) return false;
        added.add(callKey);
        return true;
      });
      if (!unique.length) continue;
      const hydrated = await this.hydrate(unique, ref.cycleId);
      steps.push(...freezeCalls(hydrated, new Map(), settings, ref.cycleId));
    }
    return steps;
  }

  private async loadLiveOverlaps(root: CallRecord): Promise<CallRecord[]> {
    const from = root.timestamp;
    const to = new Date(new Date(from).getTime() + (root.duration_ms ?? 0)).toISOString();
    const overlaps = await firstValueFrom(this.live.getCallOverlaps({ from, to, search: '', supplier: '', sessionId: '', operationId: '', requestId: '' }));
    const calls = await Promise.all(overlaps.map((item) => firstValueFrom(this.live.getSummary(item.id, item.source))));
    return calls.some((call) => call.id === root.id && call.source === 'internal') ? calls : [root, ...calls];
  }
}

function findNode(nodes: readonly CallTreeNode[], id: string): CallTreeNode | null {
  for (const node of nodes) {
    if (node.call.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function flattenNode(node: CallTreeNode): CallRecord[] {
  return [node.call, ...node.children.flatMap(flattenNode)];
}
