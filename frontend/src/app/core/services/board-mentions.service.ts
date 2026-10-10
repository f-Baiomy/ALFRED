import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, concatMap, from, map, of, toArray } from 'rxjs';
import { PickedCall } from '../models/call-ref.model';
import { MentionRef, mentionTypeOf } from '../models/board.models';
import { callOf, serializeMention, slug } from '../../shared/utils/mention-syntax';
import { BoardApiService } from './board-api.service';
import { CallFocusService } from './call-focus.service';
import { CallPickerService } from './call-picker.service';
import { CallLogsApiService } from './call-logs-api.service';
import { CallsApiService } from './calls-api.service';
import { DbCaptureApiService } from './db-capture-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

/** What a mention chip shows on hover: a few lines, or that the item is gone. */
export interface MentionPreview {
  readonly lines: readonly string[];
  readonly removed: boolean;
}

/** A card to open, by project and number - from a `@[card:...]` chip anywhere. */
export interface CardTarget {
  readonly project: string;
  readonly number: number;
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
  private readonly db = inject(DbCaptureApiService);
  private readonly logs = inject(CallLogsApiService);
  private readonly focus = inject(CallFocusService);
  private readonly picker = inject(CallPickerService);

  /** Set when a card chip is clicked; the open board view picks it up. */
  readonly cardToOpen = signal<CardTarget | null>(null);
  /** Set when a call (or statement, log line, Redis) chip is clicked; the call popup shows it. */
  readonly callToShow = signal<MentionCallTarget | null>(null);
  /** Set when a spec chip is clicked; the spec viewer shows it. */
  readonly specToShow = signal<SpecTarget | null>(null);
  /** A text waiting for its card's drawer: the comment or description a pick from anywhere came back into. */
  private readonly pickedText = signal<PickedText | null>(null);

  constructor() {
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
      default:
        return of({ lines: [ref.label, ref.ref], removed: false });
    }
  }

  /** "Open in Live Calls / its cycle" from the call popup: there, with the call highlighted. */
  goToCall(target: MentionCallTarget, serviceName: string | null): void {
    this.callToShow.set(null);
    this.focus.go({ callId: target.callId, cycleId: target.cycleId, direction: target.direction === 'out' ? 'outbound' : 'inbound', serviceName });
  }

  open(ref: MentionRef): void {
    const type = mentionTypeOf(ref);
    if (type === 'call' || type === 'stmt' || type === 'log' || type === 'redis') {
      const call = type === 'call' ? callOf(ref) : { direction: 'in' as const, id: ref.ref.split('/')[0], cycleId: null };
      if (call) this.callToShow.set({ direction: call.direction, callId: call.id, cycleId: call.cycleId, label: ref.label });
      return;
    }
    if (type === 'spec') {
      const target = specOf(ref);
      if (target) this.specToShow.set(target);
      return;
    }
    if (type === 'card') {
      const target = cardOf(ref);
      if (target) this.cardToOpen.set(target);
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
    void navigator.clipboard?.writeText(ref.ref);
  }
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

export function cardOf(ref: MentionRef): CardTarget | null {
  const m = /^(.*)#(\d+)$/.exec(ref.ref);
  return m ? { project: m[1], number: Number(m[2]) } : null;
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

