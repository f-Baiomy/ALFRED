import { TeamApiService } from '../team/team-api.service';
import { TeamItemPeekService } from '../team/item-peek.service';
import { PAGE_SCROLLERS, POPUP_SCROLLERS, ReturnPointService, captureScrolls } from './return-point.service';
import { Injectable, Signal, WritableSignal, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { EMPTY, Observable, catchError, concatMap, expand, forkJoin, from, map, of, reduce, shareReplay, switchMap, throwError, toArray } from 'rxjs';
import { PickedCall } from '../models/call-ref.model';
import { CardStatus, MentionRef, Requirement, RequirementsView, Resolution, STATUS_LABELS, VERDICT_LABELS, mentionTypeOf } from '../models/board.models';
import { CallEndpointSource, CallRecord } from '../models/call.model';
import { CallsQuery } from '../state/call-list-view';
import { acLabel, acOf, callMeaning, cardLabel, cycleCallLabel, cycleCallOf, entryLabel, numberedCalls, shortOf } from '../../shared/utils/readable-refs';
import { callTime } from '../../shared/utils/call-utils';
import { callOf, serializeMention, slug } from '../../shared/utils/mention-syntax';
import { BoardApiService } from './board-api.service';
import { BoardSocketService } from './board-socket.service';
import { CallFocusService } from './call-focus.service';
import { CallPickerService } from './call-picker.service';
import { CallLogsApiService } from './call-logs-api.service';
import { CallsApiService } from './calls-api.service';
import { DbCaptureApiService } from './db-capture-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';
import { copyToClipboard } from '../../shared/utils/clipboard';

/** What a mention chip shows on hover: a few lines, or that the item is gone. */
export interface MentionPreview {
  readonly lines: readonly string[];
  readonly removed: boolean;
}

/** A card to open, by project and number - from a `@[card:...]` chip anywhere. */
export interface CardTarget {
  readonly project: string;
  readonly number: number;
  /** A history entry to scroll to and flash once the drawer is open (specs/021: a reference to a comment). */
  readonly entryId?: number | null;
}

/** The card a "Pick from anywhere" adds its calls to. Plain data: it rides in the pick's sessionStorage resume. */
export interface CardPickTarget {
  readonly id: string;
  readonly project: string;
  readonly number: number;
  readonly cycleId: string | null;
}

/** Which text of a card a pick from anywhere was started in. */
export type TextPickField = 'comment' | 'description';

/**
 * Where calls picked from anywhere go: into the text the pick was started in (where its @ was), or onto the card's
 * Linked list ("+ link").
 */
export type CardPickInto =
  | { readonly kind: 'text'; readonly field: TextPickField; readonly text: string; readonly at: number }
  | { readonly kind: 'links' };

/** A text to put back into a card's comment box or description, with the picked calls written in. */
export interface PickedText {
  readonly cardId: string;
  readonly field: TextPickField;
  readonly text: string;
}

interface CardPickResume {
  readonly card: CardPickTarget;
  readonly into: CardPickInto;
}

/** Who asked the app-wide call picker (CallPickerService) - only the board takes this result. */
export const BOARD_PICK_REQUESTER = 'board-card-links';

/** A call to show in the popup: from a call chip, or the call a statement / log line / Redis chip belongs to. */
export interface MentionCallTarget {
  readonly direction: 'in' | 'out';
  readonly callId: string;
  readonly cycleId: string | null;
  /** The mention's saved label - the popup's title, and what is left when the call is gone. */
  readonly label: string;
  /**
   * specs/021: a statement, log line or Redis command chip opens its call AND the database window at that part -
   * the statement or Redis command (`seq`) opened and flashed, the Logs view for a line.
   */
  readonly part?: 'stmts' | 'logs' | 'redis' | null;
  readonly seq?: number | null;
}

/** What a chip reads now (specs/021): the meaning looked up, and a dot for the state. */
export interface LiveMention {
  /** Null: the chip keeps its own saved label (a call's label is already its meaning; only its state is added). */
  readonly label: string | null;
  readonly tone: 'ok' | 'warn' | 'bad' | 'dim' | 'info' | null;
  /** The state in words, for the dot's title: "Verified", "No data", "500". */
  readonly state: string | null;
}

/** A spec file to show, optionally at a section. */
export interface SpecTarget {
  readonly cycleId: string;
  readonly name: string;
  readonly section: string | null;
}

/**
 * Resolves and opens what a mention points at (FR-023, FR-026): a hover preview fetched on demand (never for every chip
 * on screen), and a click that goes to the item. Cards and spec files open in place through the two signals; calls go
 * through CallFocusService like every other "open this call".
 */
@Injectable({ providedIn: 'root' })
export class BoardMentionsService {
  private readonly router = inject(Router);
  private readonly board = inject(BoardApiService);
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);
  private readonly team = inject(TeamApiService);
  private readonly peek = inject(TeamItemPeekService);
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly focus = inject(CallFocusService);
  private readonly returns = inject(ReturnPointService);
  private readonly picker = inject(CallPickerService);

  /** Set when a card chip is clicked; the open board view picks it up. */
  readonly cardToOpen = signal<CardTarget | null>(null);
  /** A chat mention clicked (specs/022): the chat panel opens that chat at the message. */
  readonly chatToOpen = signal<{ project: string; scope: string; messageId: number } | null>(null);
  /** Set when a call (or statement, log line, Redis) chip is clicked; the call popup shows it. */
  readonly callToShow = signal<MentionCallTarget | null>(null);
  /** Set when a spec chip is clicked; the spec viewer shows it. */
  readonly specToShow = signal<SpecTarget | null>(null);
  /** A text waiting for its card's drawer: the comment or description a pick from anywhere came back into. */
  private readonly pickedText = signal<PickedText | null>(null);
  /** The history entry a reference points at: the open drawer scrolls to it and flashes it, then clears this. */
  readonly entryToShow = signal<number | null>(null);
  private readonly liveCache = new Map<string, { readonly ref: MentionRef; readonly value: WritableSignal<LiveMention | null> }>();
  private readonly requirementsCache = new Map<string, Observable<RequirementsView>>();
  private readonly numberedCache = new Map<string, Observable<CallRecord[]>>();

  constructor() {
    // A card's status or an item's verdict changed: chips read their reference again - at most every few seconds, so a
    // burst of changes while Claude works is one look-up per chip, not one per change.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const what = new Set<'cards' | 'items'>();
    inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type !== 'board-changed') return;
      if (e.what === 'card') what.add('cards');
      else if (e.what === 'requirements' || e.what === 'checklist') what.add('items');
      else return;
      pending ??= setTimeout(() => {
        pending = null;
        this.refresh(what.has('cards'), what.has('items'), false);
        what.clear();
      }, 3000);
    });
    // Back from "Pick from anywhere" (the page this lives on may have been rebuilt meanwhile): link what was picked.
    effect(() => {
      if (this.picker.hasResult(BOARD_PICK_REQUESTER)) untracked(() => this.linkPicked());
    });
  }

  /**
   * "Pick from anywhere" for a card: the user walks Live Calls and any cycle with the pick bar, and Return comes
   * back to the board with the card open and every picked call linked to it.
   */
  pickForCard(card: CardPickTarget, into: CardPickInto): void {
    this.picker.start({
      requester: BOARD_PICK_REQUESTER,
      title: into.kind === 'text' ? `Calls to mention in the ${into.field} of card #${card.number}` : `Calls to link to card #${card.number}`,
      mode: 'multi',
      returnUrl: this.router.createUrlTree(['/board'], { queryParams: { project: card.project || null, cycle: card.cycleId,
        card: card.number } }).toString(),
      returnLabel: `card #${card.number}`,
      resume: { card, into } satisfies CardPickResume,
    });
  }

  /** The drawer of `cardId` takes the text a pick came back into (once). */
  takePickedText(cardId: string): PickedText | null {
    const text = this.pickedText();
    if (!text || text.cardId !== cardId) return null;
    this.pickedText.set(null);
    return text;
  }

  private linkPicked(): void {
    const result = this.picker.takeResult(BOARD_PICK_REQUESTER);
    const resume = result?.resume as CardPickResume | undefined;
    const card = resume?.card;
    if (!result || !resume || !card?.id) return;
    if (resume.into.kind === 'text') {
      // Cancelled or not, the text the user was writing comes back - with the picks written in where the @ was.
      const { text, at, field } = resume.into;
      const written = result.picked.map((p) => serializeMention(pickedMention(p))).join(' ');
      const joined = written ? `${text.slice(0, at)}${written} ${text.slice(at)}` : text;
      this.pickedText.set({ cardId: card.id, field, text: joined });
      this.cardToOpen.set({ project: card.project, number: card.number });
      return;
    }
    if (!result.picked.length) {
      this.cardToOpen.set({ project: card.project, number: card.number });
      return;
    }
    from(result.picked).pipe(
      concatMap((p) => this.board.link(card.id, pickedMention(p)).pipe(catchError(() => of(null)))),
      toArray(),
    ).subscribe(() => this.cardToOpen.set({ project: card.project, number: card.number }));
  }

  // ------------------------------------------------------------------------------------------- live labels (021)

  /**
   * What a chip reads now: a card by its short name (or its title cut short) and status, an Acceptance item by its short
   * name and verdict, a cycle's call by what it was - looked up once per reference and kept until {@link forget}. Null
   * while it loads, and for a kind whose saved label is already its meaning.
   */
  live(ref: MentionRef): Signal<LiveMention | null> {
    const key = `${ref.type.toLowerCase()}:${ref.ref}`;
    let entry = this.liveCache.get(key);
    if (!entry) {
      entry = { ref, value: signal<LiveMention | null>(fromLabel(ref)) };
      this.liveCache.set(key, entry);
      this.ask(entry);
    }
    return entry.value;
  }

  /**
   * Short names or statuses changed: the chips of cards and/or Acceptance items look their reference up again - each keeps
   * what it reads until the new answer comes, so nothing flickers back to its saved label. A cycle's numbered calls
   * never change; they are asked again only with `calls`.
   */
  refresh(cards = true, items = true, calls = false): void {
    if (items) this.requirementsCache.clear();
    if (calls) this.numberedCache.clear();
    for (const entry of this.liveCache.values()) {
      const type = mentionTypeOf(entry.ref);
      if ((cards && type === 'card') || (items && type === 'spec') || (calls && cycleCallOf(entry.ref))) this.ask(entry);
    }
  }

  /** The user changed a short name or a mark here: everything is read again. */
  forget(): void {
    this.refresh(true, true, false);
  }

  private ask(entry: { readonly ref: MentionRef; readonly value: WritableSignal<LiveMention | null> }): void {
    // Never inside the reading computed: a cached look-up answers at once, and a signal may not be set there.
    queueMicrotask(() => this.lookUp(entry.ref)?.subscribe({ next: (v) => entry.value.set(v), error: () => undefined }));
  }

  private lookUp(ref: MentionRef): Observable<LiveMention> | null {
    const type = mentionTypeOf(ref);
    if (type === 'card') {
      const target = cardOf(ref);
      if (!target) return null;
      if (target.entry) {
        return this.entryOf(target).pipe(map((e) => ({ label: e ? entryLabel(e.actor, e.kind, e.at, e.text) : ref.label, tone: null, state: null })));
      }
      return this.board.cardByNumber(target.project, target.number).pipe(map((c) => ({
        label: cardLabel(c.shortName || shortOf(c.title), c.number), ...cardTone(c.status, c.resolution ?? null) })));
    }
    if (type === 'spec') {
      const target = specOf(ref);
      const n = acOf(target?.section);
      if (!target || n === null) return null;
      return this.itemOf(target.cycleId, n).pipe(map((item) => item
        ? { label: acLabel(item.shortName || shortOf(item.text), n), ...itemTone(item) }
        : { label: `AC${n} (no such item)`, tone: 'dim' as const, state: 'not found' }));
    }
    const numbered = cycleCallOf(ref);
    if (numbered) {
      return this.numbered(numbered.cycleId).pipe(map((calls) => {
        const c = calls[numbered.n - 1];
        if (!c) return { label: `call ${numbered.n} (not in the cycle)`, tone: 'dim' as const, state: 'not found' };
        const status = c.response?.status ?? null;
        return { label: cycleCallLabel(callMeaning(c.method, c.url, status), numbered.n), ...statusTone(status) };
      }));
    }
    return null;
  }

  /** A cycle's Acceptance item n (AC1… in order), cached per cycle until {@link forget}. */
  itemOf(cycleId: string, n: number): Observable<Requirement | null> {
    let r = this.requirementsCache.get(cycleId);
    if (!r) {
      r = this.board.requirements(cycleId).pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.requirementsCache.set(cycleId, r);
    }
    return r.pipe(map((v) => v.items[n - 1] ?? null), catchError(() => of(null)));
  }

  /** A cycle's calls in the order its numbers count them (both directions, no preflights, oldest first). */
  numbered(cycleId: string): Observable<CallRecord[]> {
    let r = this.numberedCache.get(cycleId);
    if (!r) {
      r = forkJoin([this.allCalls(cycleId, 'external'), this.allCalls(cycleId, 'internal')]).pipe(
        map(([out, inn]) => numberedCalls([...out, ...inn], callTime)),
        shareReplay({ bufferSize: 1, refCount: false }));
      this.numberedCache.set(cycleId, r);
    }
    return r;
  }

  /** Every captured call of a cycle, both directions, read now (not the numbered cache): the board's Calls tab. */
  cycleCalls(cycleId: string): Observable<CallRecord[]> {
    return forkJoin([this.allCalls(cycleId, 'external'), this.allCalls(cycleId, 'internal')]).pipe(map(([out, inn]) => [...out, ...inn]));
  }

  /** Every captured call of one direction, page by page (each answer holds at most the server's page limit). */
  private allCalls(cycleId: string, source: CallEndpointSource): Observable<CallRecord[]> {
    const pageSize = 200;
    const page = (offset: number) => this.cycles.listCalls(cycleId, { search: '', supplier: '', sort: 'oldest-call', offset, limit: pageSize,
      sessionId: '', operationId: '', requestId: '' } as CallsQuery, source, undefined, true);
    let offset = 0;
    return page(0).pipe(
      expand((p) => {
        offset += p.calls.length;
        return p.calls.length === pageSize && offset < p.total ? page(offset) : EMPTY;
      }),
      reduce((all: CallRecord[], p) => [...all, ...p.calls.map((c) => c.call)], []));
  }

  /** The history entry a card reference points at: `/e<id>` by id, `/i<n>` by its place in the history (board_get's [n]). */
  private entryOf(target: CardRefTarget): Observable<{ id: number; actor: string; kind: string; at: string; text: string | null } | null> {
    const entry = target.entry;
    if (!entry) return of(null);
    return this.board.cardByNumber(target.project, target.number).pipe(
      switchMap((c) => this.board.activity(c.id, 0, 1000)),
      map((page) => (entry.by === 'i' ? page.entries[entry.n] : page.entries.find((e) => e.id === entry.n)) ?? null),
      catchError(() => of(null)));
  }

  preview(ref: MentionRef): Observable<MentionPreview> {
    const type = mentionTypeOf(ref);
    const gone = (): Observable<MentionPreview> => of({ lines: [ref.label], removed: true });
    switch (type) {
      case 'call': {
        const call = callOf(ref);
        if (!call) return gone();
        const source = call.direction === 'out' ? 'external' : 'internal';
        const summary$: Observable<{ method?: string; url?: string; status?: number }> = call.cycleId
          ? this.cycles.getDetail(call.cycleId, call.id, source).pipe(map((d) => ({ status: d.response?.status })))
          : this.calls.getSummary(call.id, source).pipe(map((c) => ({ method: c.method, url: c.url, status: c.response?.status })));
        return summary$.pipe(
          map((c) => ({ lines: [ref.label, [c.method, c.url, c.status].filter((x) => x !== undefined && x !== null).join(' '),
            `${call.direction === 'out' ? 'outbound' : 'inbound'}${call.cycleId ? ' · in a cycle' : ' · live'}`], removed: false })),
          catchError(gone));
      }
      case 'stmt': {
        const [callId, seq] = ref.ref.split('/');
        return this.db.statements(callId).pipe(
          map((page) => {
            const st = page.statements.find((s) => String(s.seq) === seq);
            return st ? { lines: [ref.label, st.sql.slice(0, 600), `${st.durationMicros / 1000} ms`], removed: false } : { lines: [ref.label], removed: true };
          }),
          catchError(gone));
      }
      case 'log': {
        const slash = ref.ref.indexOf('/');
        const callId = ref.ref.slice(0, slash);
        const lineId = ref.ref.slice(slash + 1);
        return this.logs.allLines(callId).pipe(
          map((lines) => {
            const line = lines.find((l) => l.lineId === lineId);
            return line ? { lines: [`${line.level ?? ''} ${line.logger ?? ''}`.trim(), line.message.slice(0, 600)], removed: false }
              : { lines: [ref.label], removed: true };
          }),
          catchError(gone));
      }
      case 'redis': {
        const [callId, seq] = ref.ref.split('/');
        return this.db.storeCommands(callId).pipe(
          map((page) => {
            const cmd = page.commands.find((c) => String(c.seq) === seq);
            return cmd ? { lines: [ref.label, `${cmd.command} ${cmd.keys.join(' ')}`], removed: false } : { lines: [ref.label], removed: true };
          }),
          catchError(gone));
      }
      case 'spec': {
        const target = specOf(ref);
        if (!target) return gone();
        return this.board.spec(target.cycleId, target.name).pipe(
          map((text) => ({ lines: [ref.label, ...sectionLines(text, target.section).slice(0, 6)], removed: false })),
          catchError(gone));
      }
      case 'card': {
        const target = cardOf(ref);
        if (!target) return gone();
        return this.board.cardByNumber(target.project, target.number).pipe(
          map((c) => ({ lines: [`#${c.number} ${c.title}`, `${c.kind} · ${c.status}${c.resolution ? ` · ${c.resolution}` : ''}`], removed: false })),
          catchError(gone));
      }
      case 'cycle':
        return this.cycles.get(ref.ref).pipe(map((c) => ({ lines: [c.name, c.status], removed: false })), catchError(gone));
      case 'workitem': {
        // specs/028: `<conn>/<itemId>`, read live with the token in Alfred's memory (none: the saved label)
        const w = workItemOf(ref);
        if (!w) return gone();
        return this.peek.connOf(w.conn).pipe(switchMap((conn) => (conn ? this.team.item(conn, w.extId, '') : throwError(() => ({ status: 401 })))),
          map((d) => ({ lines: [`${d.item.extId} ${d.item.title}`, [d.item.type, d.item.state, d.item.assignee].filter(Boolean).join(' · ')], removed: false })),
          catchError((e) => (e?.status === 404 ? gone() : of({ lines: [ref.label, 'Enter the token on the Team tab to read it live'], removed: false }))));
      }
      case 'person': {
        // specs/028 FR-088: `<conn>/<personId>`, from the Team lists
        const w = workItemOf(ref);
        if (!w) return gone();
        return this.team.person(w.conn, w.extId).pipe(
          map((p) => ({ lines: [p.person.name + (p.me ? ' (me)' : ''), [p.person.email, p.teams.map((t) => t.name).join(', ')].filter(Boolean).join(' · '),
            `${p.assignedOpen ?? '?'} open items · ${p.cardsOwned.length} cards owned`], removed: false })),
          catchError(() => of({ lines: [ref.label], removed: false })));
      }
      default:
        return of({ lines: [ref.label, ref.ref], removed: false });
    }
  }

  /** "Open in Live Calls / its cycle" from the call popup: there, with the call highlighted. */
  goToCall(target: MentionCallTarget, serviceName: string | null): void {
    // Exactly where the user is: the page, the open card, this popup, and every scroll - read before the popup closes.
    this.returns.set({
      url: this.router.url, card: this.returns.openCard(), popup: target,
      scrolls: captureScrolls(PAGE_SCROLLERS), popupScrolls: captureScrolls(POPUP_SCROLLERS, false),
    });
    this.callToShow.set(null);
    const direction = target.direction === 'out' ? 'outbound' : 'inbound';
    if (target.cycleId) {
      // Its cycle with every call listed, scrolled to this one and pointing at it - the way "Show in cycle" does.
      this.focus.revealIn({ callId: target.callId, cycleId: target.cycleId, direction, serviceName, preflight: false });
    } else {
      this.focus.go({ callId: target.callId, cycleId: null, direction, serviceName });
    }
  }

  open(ref: MentionRef): void {
    const type = mentionTypeOf(ref);
    const label = this.live(ref)()?.label ?? ref.label;
    const numbered = cycleCallOf(ref);
    if (numbered) {
      // "call 75" of a cycle: its number found among the cycle's calls, then the call popup as for any call chip
      this.numbered(numbered.cycleId).subscribe((calls) => {
        const c = calls[numbered.n - 1];
        if (c) this.callToShow.set({ direction: c.source === 'internal' ? 'in' : 'out', callId: c.id, cycleId: numbered.cycleId, label });
      });
      return;
    }
    if (type === 'call' || type === 'stmt' || type === 'log' || type === 'redis') {
      const [callId, rest] = ref.ref.split('/');
      const call = type === 'call' ? callOf(ref) : { direction: 'in' as const, id: callId, cycleId: null };
      const part = type === 'stmt' ? 'stmts' as const : type === 'log' ? 'logs' as const : type === 'redis' ? 'redis' as const : null;
      const seq = part && part !== 'logs' && /^\d+$/.test(rest ?? '') ? Number(rest) : null;
      if (call) this.callToShow.set({ direction: call.direction, callId: call.id, cycleId: call.cycleId, label, part, seq });
      return;
    }
    if (type === 'spec') {
      const target = specOf(ref);
      const n = acOf(target?.section);
      if (target && n !== null) {
        // An Acceptance item: the spec file it is in, opened at it
        this.itemOf(target.cycleId, n).subscribe((item) => { if (item) this.specToShow.set({ ...target, name: item.fileName }); });
        return;
      }
      if (target && target.name !== '*') this.specToShow.set(target);
      return;
    }
    if (type === 'card') {
      const target = cardOf(ref);
      if (!target) return;
      if (target.entry) {
        this.entryOf(target).subscribe((e) => {
          this.entryToShow.set(e?.id ?? null);
          this.cardToOpen.set({ project: target.project, number: target.number, entryId: e?.id ?? null });
        });
        return;
      }
      this.cardToOpen.set({ project: target.project, number: target.number });
      return;
    }
    if (type === 'cycle' || type === 'spacer') {
      void this.router.navigate(['/cycles', ref.ref.split('/')[0]]);
      return;
    }
    if (type === 'rule') {
      void this.router.navigate(['/interception']);
      return;
    }
    if (type === 'workitem') {
      const w = workItemOf(ref);
      if (w) this.peek.open(w.conn, w.extId); // the item's drawer over this page - the board stays where it is
      return;
    }
    if (type === 'person') {
      const w = workItemOf(ref);
      if (w) void this.router.navigate(['/team'], { queryParams: { conn: w.conn, person: w.extId } });
      return;
    }
    if (type === 'chat') {
      // specs/022: `<project>/<scope>#<message id>` - the chat opens at that message, which flashes
      const m = /^(.*)\/([^/#]+)#(\d+)$/.exec(ref.ref);
      if (m) this.chatToOpen.set({ project: m[1], scope: m[2], messageId: Number(m[3]) });
      return;
    }
    void copyToClipboard(ref.ref);
  }
}

/** A work item mention's connection and id: `<conn>/<itemId>`. */
export function workItemOf(ref: MentionRef): { conn: string; extId: string } | null {
  const m = /^([^/]+)\/(.+)$/.exec(ref.ref);
  return m ? { conn: m[1], extId: m[2] } : null;
}

/** A picked call as a call mention: `in:<id>` / `out:<id>`, with `@<cycle>` when it was picked inside a cycle. */
export function pickedMention(p: PickedCall): MentionRef {
  let path = p.call.url;
  try {
    path = new URL(p.call.url).pathname;
  } catch {
    // already a path
  }
  const status = p.call.response?.status ?? (p.call.error ? 'error' : '…');
  return {
    type: 'call',
    ref: `${p.ref.source === 'internal' ? 'in' : 'out'}:${p.ref.callId}${p.ref.cycleId ? `@${p.ref.cycleId}` : ''}`,
    label: `${p.call.method} ${path} · ${status}`,
  };
}

export function specOf(ref: MentionRef): SpecTarget | null {
  const slash = ref.ref.indexOf('/');
  if (slash < 0) return null;
  const rest = ref.ref.slice(slash + 1);
  const hash = rest.indexOf('#');
  return { cycleId: ref.ref.slice(0, slash), name: hash < 0 ? rest : rest.slice(0, hash), section: hash < 0 ? null : rest.slice(hash + 1) };
}

/** A card reference, and (specs/021) the history entry it points at: `/e<entry id>`, or `/i<n>` - its place in the history. */
export interface CardRefTarget extends CardTarget {
  readonly entry?: { readonly by: 'i' | 'e'; readonly n: number } | null;
}

export function cardOf(ref: MentionRef): CardRefTarget | null {
  const m = /^(.*)#(\d+)(?:\/([ie])(\d+))?$/.exec(ref.ref);
  return m ? { project: m[1], number: Number(m[2]), entry: m[3] ? { by: m[3] as 'i' | 'e', n: Number(m[4]) } : null } : null;
}

/** A call chip's state is in its saved label ("POST /orders · 500"): no fetch for it. */
function fromLabel(ref: MentionRef): LiveMention | null {
  if (mentionTypeOf(ref) !== 'call' || cycleCallOf(ref)) return null;
  const status = labelStatus(ref.label);
  return status ? { label: null, ...statusTone(Number(status)) } : null;
}

/** The HTTP status a call label carries ("POST /orders · 500"), never a call number ("(call 500)"). */
export function labelStatus(label: string): string | undefined {
  return /·\s*([1-5]\d\d)(?=\s|$|\))/.exec(label)?.[1];
}

function statusTone(status: number | null): Pick<LiveMention, 'tone' | 'state'> {
  if (!status) return { tone: null, state: null };
  return { tone: status >= 500 ? 'bad' : status >= 400 ? 'warn' : null, state: String(status) };
}

function cardTone(status: CardStatus, resolution: Resolution | null): Pick<LiveMention, 'tone' | 'state'> {
  const words = STATUS_LABELS[status] ?? status;
  if (status === 'VERIFIED' || status === 'DONE') return { tone: 'ok', state: words };
  if (status === 'FIXED') return { tone: 'info', state: words };
  if (status === 'CLOSED') return { tone: 'dim', state: resolution ? `${words} · ${resolution.toLowerCase().replace(/_/g, ' ')}` : words };
  return { tone: null, state: words };
}

function itemTone(item: Requirement): Pick<LiveMention, 'tone' | 'state'> {
  if (item.mark === 'PASS') return { tone: 'ok', state: 'Your mark: pass' };
  if (item.mark === 'FAIL') return { tone: 'bad', state: 'Your mark: fail' };
  const v = item.verdict.verdict;
  const state = VERDICT_LABELS[v] ?? v;
  if (v === 'MET') return { tone: 'ok', state };
  if (v === 'MISSING' || v === 'WRONG') return { tone: 'bad', state };
  if (v === 'NO_DATA' || v === 'NOT_EXERCISED') return { tone: 'warn', state };
  return { tone: null, state };
}

/** The lines under the heading whose slug is `section` (the whole text when none). */
export function sectionLines(text: string, section: string | null): string[] {
  const lines = text.split(/\r?\n/);
  if (!section) return lines.filter((l) => l.trim());
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()) && slug(l.trim().replace(/^#{1,6}\s+/, '')) === section);
  if (start < 0) return lines.filter((l) => l.trim());
  const level = (/^#+/.exec(lines[start].trim()) ?? [''])[0].length;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i].trim());
    if (m && m[1].length <= level) break;
    if (lines[i].trim()) out.push(lines[i]);
  }
  return out;
}

