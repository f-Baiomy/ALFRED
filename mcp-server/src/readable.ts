import { AlfredError, seg, type AlfredClient } from './alfred-client.ts';
import { listCycleCalls, segmentOf } from './cycle-calls.ts';
import {
  acLabel, callMeaning, callTime, cardLabel, cycleCallLabel, entryLabel, findBareRefs, numberedCalls, replaceBareRefs, shortOf, toCallRecord,
} from './frontend.ts';
import type { BareRef, CallEndpointSource, CallRecord, CallSummaryDto } from './frontend.ts';

/**
 * Readable references (specs/021): what Claude writes on the board is read by people who were not in its session. The
 * shorthand it works in - `AC8`, `#47`, `calls #75, #81`, `[6]`, a call id - means nothing to them. Before a text is
 * saved, each such code is looked up and written as the mention it is, labelled with its meaning:
 * `@[spec:<cycle>/spec.md#ac8|one-branch search (AC8)]`, `@[card:odeysys#47|All Agencies untested (#47)]`,
 * `@[call:in:<id>@<cycle>|POST refunded-requests/search · 200 (call 75)]`. The board draws each as its chip. The finder is
 * the board's own (frontend `readable-refs.ts`), so what is converted here and what the board draws in older text agree.
 *
 * A code that cannot be found is left as written and reported, so Claude can fix it.
 */
export interface ReadableScope {
  readonly project: string;
  readonly cycleId?: string | null;
  /** The card the text goes on - `[6]` is an entry of its history. */
  readonly card?: { readonly id: string; readonly number: number } | null;
}

export interface Readable {
  readonly text: string;
  /** "AC8 → one-branch search (AC8)" for each code written as its mention. */
  readonly converted: readonly string[];
  /** Codes that could not be looked up - left as written. */
  readonly unknown: readonly string[];
}

interface ItemRow { readonly fileName: string; readonly itemKey: string; readonly text: string; readonly shortName?: string | null }
interface CardLite { readonly number: number; readonly title: string; readonly shortName?: string | null }
interface EntryRow { readonly id: number; readonly actor: string; readonly kind: string; readonly text: string | null; readonly at: string }

/** One look-up per thing per write - several texts of one call share it. */
export class ReadableWriter {
  private items?: Promise<readonly ItemRow[]>;
  private calls?: Promise<readonly CallRecord[]>;
  private entries?: Promise<readonly EntryRow[]>;
  private readonly cards = new Map<number, Promise<CardLite | null>>();
  private readonly ids = new Map<string, Promise<{ ref: string; label: string; type: 'call' | 'cycle' } | null>>();
  readonly converted: string[] = [];
  readonly unknown: string[] = [];

  constructor(private readonly client: AlfredClient, private readonly scope: ReadableScope) {}

  /** The text with its shorthand as mentions - or as written when the mentions would make it longer than `max` allows. */
  async text(text: string | undefined | null, max = Infinity): Promise<string> {
    if (!text) return text ?? '';
    const before = this.converted.length;
    const out = await this.convert(text);
    if (out.length <= max) return out;
    this.converted.length = before; // none of this text's conversions were saved
    this.note(this.unknown, `(a text left as written: with its mentions it would be over ${max} characters)`);
    return text;
  }

  private async convert(text: string): Promise<string> {
    const refs = findBareRefs(text);
    if (!refs.length) return text;
    const resolved = new Map<BareRef, { type: string; ref: string; label: string } | null | undefined>();
    for (const r of refs) resolved.set(r, await this.resolve(r));
    return replaceBareRefs(text, refs, (r) => {
      const m = resolved.get(r);
      if (!m) {
        // null: looked up and not there; undefined: nothing to look it up in (no cycle, no card) - or a short id that
        // matched no call (it may be any hex word)
        if (m === null && r.kind !== 'shortId') this.note(this.unknown, r.raw);
        return null;
      }
      // a mention's label may be 200 characters at most, or the board shows the raw text
      const label = m.label.length > 120 ? `${m.label.slice(0, 119)}…` : m.label;
      this.note(this.converted, `${r.raw} → ${label}`);
      return { ...m, label };
    });
  }

  /** What the reply says: converted codes, and the ones left as written. */
  report(): Record<string, string> {
    return {
      ...(this.converted.length ? { readable: `written as mentions with their meaning: ${this.converted.join('; ')}` } : {}),
      ...(this.unknown.length ? { notFound: `left as written - no such item, card, call or comment: ${this.unknown.join(', ')}. `
        + 'Write what each is in words, or mention it with @[type:ref|meaning].' } : {}),
    };
  }

  private note(list: string[], s: string): void {
    if (!list.includes(s)) list.push(s);
  }

  private async resolve(r: BareRef): Promise<{ type: string; ref: string; label: string } | null | undefined> {
    const { project, cycleId, card } = this.scope;
    if (r.kind === 'ac' && cycleId) {
      const item = (await this.itemList())[r.n! - 1];
      return item ? { type: 'spec', ref: `${cycleId}/${item.fileName}#ac${r.n}`, label: acLabel(item.shortName || shortOf(item.text), r.n!) } : null;
    }
    if (r.kind === 'card' && project) {
      const c = await this.cardOf(r.n!);
      return c ? { type: 'card', ref: `${project}#${c.number}`, label: cardLabel(c.shortName || shortOf(c.title), c.number) } : null;
    }
    if (r.kind === 'cycleCall' && cycleId) {
      const c = (await this.callList())[r.n! - 1];
      return c ? { type: 'call', ref: `${c.source === 'external' ? 'out' : 'in'}:${c.id}@${cycleId}`,
        label: cycleCallLabel(callMeaning(c.method, c.url, c.response?.status ?? (c.error ? 'error' : null)), r.n!) } : null;
    }
    if (r.kind === 'history' && card) {
      const e = (await this.entryList())[r.n!];
      return e ? { type: 'card', ref: `${project}#${card.number}/e${e.id}`, label: entryLabel(e.actor, e.kind, e.at, e.text) } : null;
    }
    if (r.kind === 'shortId' && cycleId) {
      const c = (await this.callList()).find((x) => x.id.startsWith(r.id!));
      return c ? { type: 'call', ref: `${c.source === 'external' ? 'out' : 'in'}:${c.id}@${cycleId}`,
        label: callMeaning(c.method, c.url, c.response?.status ?? (c.error ? 'error' : null)) } : null;
    }
    if (r.kind === 'uuid') return this.idOf(r.id!);
    return undefined;
  }

  private itemList(): Promise<readonly ItemRow[]> {
    this.items ??= this.client.get<{ items: ItemRow[] }>(`/board/cycles/${seg(this.scope.cycleId!)}/requirements`)
      .then((v) => v.items ?? [], () => []);
    return this.items;
  }

  private callList(): Promise<readonly CallRecord[]> {
    this.calls ??= listCycleCalls(this.client, this.scope.cycleId!)
      .then((l) => numberedCalls(l.entries.map((e) => e.call), callTime), () => []);
    return this.calls;
  }

  private entryList(): Promise<readonly EntryRow[]> {
    const card = this.scope.card!;
    this.entries ??= (async () => {
      const out: EntryRow[] = [];
      for (;;) {
        const page = await this.client.get<{ entries: EntryRow[]; total: number }>(`/board/cards/${seg(card.id)}/activity`, { query: { offset: out.length, limit: 1000 } });
        out.push(...page.entries);
        if (!page.entries.length || out.length >= page.total) return out;
      }
    })().catch(() => []);
    return this.entries;
  }

  private cardOf(n: number): Promise<CardLite | null> {
    let c = this.cards.get(n);
    if (!c) {
      c = this.client.get<CardLite>(`/board/cards/by-number/${seg(n)}`, { query: { project: this.scope.project } }).catch(() => null);
      this.cards.set(n, c);
    }
    return c;
  }

  /** A whole UUID: a call (inbound first), else a session cycle. */
  private idOf(id: string): Promise<{ ref: string; label: string; type: 'call' | 'cycle' } | null> {
    let found = this.ids.get(id);
    if (!found) {
      found = (async () => {
        for (const source of ['internal', 'external'] as CallEndpointSource[]) {
          try {
            const dto = await this.client.get<CallSummaryDto>(`/${segmentOf(source)}/${seg(id)}/summary`);
            const c = toCallRecord(dto, source);
            return { type: 'call' as const, ref: `${source === 'external' ? 'out' : 'in'}:${id}`, label: callMeaning(c.method, c.url, c.response?.status ?? null) };
          } catch (error) {
            if (!(error instanceof AlfredError) || error.kind !== 'not_found') return null;
          }
        }
        try {
          const cycle = await this.client.get<{ id: string; name: string }>(`/session-cycles/${seg(id)}`);
          return { type: 'cycle' as const, ref: id, label: cycle.name };
        } catch {
          return null;
        }
      })();
      this.ids.set(id, found);
    }
    return found;
  }
}

/** One text made readable: the text to save, and the note for the reply. */
export async function readable(client: AlfredClient, scope: ReadableScope, text: string): Promise<Readable> {
  const w = new ReadableWriter(client, scope);
  const out = await w.text(text);
  return { text: out, converted: w.converted, unknown: w.unknown };
}
