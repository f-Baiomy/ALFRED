import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CardKind, CardStatus, Flag, MentionRef } from '../models/board.models';
import { callOf } from '../../shared/utils/mention-syntax';
import { BoardApiService } from './board-api.service';
import { BoardMentionsService } from './board-mentions.service';
import { CallsApiService } from './calls-api.service';
import { ConsentService } from './consent.service';
import { RuleDraftService } from './rule-draft.service';

/** What an action may do (specs/017 R21) - the whole list; anything else is refused before any dialog. */
export const ACTION_KINDS = ['reply', 'answer', 'run-skill', 'retest', 'move', 'flag', 'propose', 'rule', 'open-call'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Where the asker is: the card, its project and cycle, and the comment a reply goes under. */
export interface ActionContext {
  readonly project?: string | null;
  readonly cardId?: string | null;
  readonly cardNumber?: number | null;
  readonly cycleId?: string | null;
  readonly comment?: number | null;
}

const STATUSES: readonly CardStatus[] = ['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'DONE'];
const KINDS: readonly CardKind[] = ['BUG', 'TASK', 'NOTE', 'QUESTION'];
const FLAGS: readonly Flag[] = ['URGENT', 'RISK', 'BLOCKER', 'AFFECTS_PROJECT', 'NEEDS_DECISION'];
const STATUS_NAMES: Readonly<Record<string, string>> = { INBOX: 'Inbox', TO_DO: 'To do', IN_PROGRESS: 'In progress', FIXED: 'Fixed', VERIFIED: 'Verified', DONE: 'Done' };

interface Plan {
  readonly title: string;
  readonly lines: readonly string[];
  readonly exact?: string;
  readonly confirm: string;
  readonly run: () => Promise<unknown>;
}

/**
 * An action chip as written - `[action: retest | Re-test now]`, `[action: run /alfred-fix 33]`, `[action: move FIXED]` -
 * as the action and its arguments. `run` is run-skill, `open` is open-call; the word after the kind is its argument.
 */
export function chipAction(kind: string, arg: string): { kind: string; args: Record<string, unknown> } {
  const k = kind.toLowerCase();
  const a = arg.trim();
  switch (k) {
    case 'run': case 'run-skill': return { kind: 'run-skill', args: { command: a } };
    case 'move': return { kind: 'move', args: { status: a } };
    case 'flag': return { kind: 'flag', args: { flag: a } };
    case 'reply': return { kind: 'reply', args: { text: a } };
    case 'answer': return { kind: 'answer', args: { text: a } };
    case 'open': case 'open-call': return { kind: 'open-call', args: { call: a.replace(/^@?\[?call:/, '').replace(/\|.*$/, '') } };
    case 'rule': return { kind: 'rule', args: { call: a.replace(/^@?\[?call:/, '').replace(/\|.*$/, '') } };
    case 'propose': return { kind: 'propose', args: { title: a } };
    default: return { kind: k, args: a ? { text: a } : {} };
  }
}

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

/**
 * Board actions asked for by a snippet (`alfred.action`), an action chip (`[action: …]`), a choice or a form (specs/017
 * R21, R22). Each is first read into a plan - the exact change, in words, with the exact text - and shown in the consent
 * dialog; only the user's click runs it, as the user. Claude's limits still apply server-side to what Claude does itself.
 */
@Injectable({ providedIn: 'root' })
export class BoardActionsService {
  private readonly board = inject(BoardApiService);
  private readonly calls = inject(CallsApiService);
  private readonly consent = inject(ConsentService);
  private readonly mentions = inject(BoardMentionsService);
  private readonly rules = inject(RuleDraftService);
  private readonly router = inject(Router);

  /** Shows the plan; runs it on the user's click. Resolves with what the change returned; rejects when refused or cancelled. */
  async perform(kind: string, args: Record<string, unknown>, ctx: ActionContext, from: string): Promise<unknown> {
    const plan = this.plan(kind, args, ctx);
    const ok = await this.consent.ask({ title: plan.title, from, lines: plan.lines, exact: plan.exact ?? null, confirmLabel: plan.confirm });
    if (!ok) throw new Error('The user said no');
    try {
      return (await plan.run()) ?? true;
    } catch (e) {
      throw new Error((e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : 'It could not be done'));
    }
  }

  /** The exact change, or an Error naming what is wrong - nothing runs here. */
  plan(kind: string, args: Record<string, unknown>, ctx: ActionContext): Plan {
    const card = ctx.cardNumber ? `#${ctx.cardNumber}` : 'this card';
    const needCard = () => { if (!ctx.cardId) throw new Error(`${kind} works on a card - this text is not on one`); return ctx.cardId; };
    switch (kind as ActionKind) {
      case 'reply': {
        const text = s(args['text']);
        if (!text) throw new Error('reply needs { text }');
        const id = needCard();
        const under = typeof args['replyTo'] === 'number' ? args['replyTo'] as number : ctx.comment ?? undefined;
        return { title: 'Post a comment', lines: [`Post this as your comment on ${card}${under ? ', under the comment it answers' : ''}`], exact: text,
          confirm: 'Post it', run: () => firstValueFrom(this.board.comment(id, text, under)) };
      }
      case 'answer': {
        const text = s(args['text'] ?? args['choice']);
        if (!text) throw new Error('answer needs { text } or { choice }');
        const id = needCard();
        const posted = args['choice'] != null ? `**Answer** choice: ${text}` : `**Answer** ${text}`;
        return { title: 'Answer the question', lines: [`Answer on ${card} as you - this clears "Needs decision"`], exact: posted, confirm: 'Answer',
          run: () => firstValueFrom(this.board.comment(id, posted, ctx.comment ?? undefined, true)) };
      }
      case 'run-skill': {
        const command = s(args['command']);
        if (!/^\/alfred-[\w-]+(\s.*)?$/s.test(command)) throw new Error('run-skill needs { command: "/alfred-…" }');
        if (!ctx.cycleId) throw new Error('A skill runs in the chat that handles a cycle - this text is not in one');
        const note = s(args['note']) || null;
        return { title: 'Run a skill', lines: [`Send ${command} to the chat that handles this cycle`, ...(note ? [`with the note: ${note}`] : [])],
          exact: command, confirm: '▶ Run', run: () => firstValueFrom(this.board.requestSkillRun({ project: ctx.project ?? '', cycleId: ctx.cycleId,
            cardNumber: ctx.cardNumber ?? null, command, prompt: command, note })) };
      }
      case 'retest': {
        if (!ctx.cardNumber || !ctx.project) throw new Error('retest works on a card');
        return { title: 'Re-test', lines: [`Re-test ${card} against the calls that arrived since it was fixed`], confirm: 'Re-test',
          run: () => firstValueFrom(this.board.retestRun(ctx.project!, [ctx.cardNumber!], ctx.cycleId ?? null)) };
      }
      case 'move': {
        const status = s(args['status'] ?? args['to']).toUpperCase().replace(/[\s-]+/g, '_') as CardStatus;
        if (!STATUSES.includes(status)) throw new Error(`move needs { status } - one of ${STATUSES.join(', ')}`);
        const id = needCard();
        return { title: 'Move the card', lines: [`Move ${card} to ${STATUS_NAMES[status]}`], confirm: `Move to ${STATUS_NAMES[status]}`,
          run: () => firstValueFrom(this.board.move(id, status)) };
      }
      case 'flag': {
        const flag = s(args['flag']).toUpperCase().replace(/[\s-]+/g, '_') as Flag;
        if (!FLAGS.includes(flag)) throw new Error(`flag needs { flag } - one of ${FLAGS.join(', ')}`);
        const on = args['on'] !== false;
        const id = needCard();
        return { title: on ? 'Flag the card' : 'Unflag the card', lines: [`${on ? 'Set' : 'Clear'} the ${flag.toLowerCase().replace('_', ' ')} flag on ${card}`],
          confirm: on ? 'Flag it' : 'Clear it', run: async () => {
            const c = await firstValueFrom(this.board.card(id));
            const flags = new Set<Flag>(c.flags as readonly Flag[]);
            if (on) flags.add(flag); else flags.delete(flag);
            return firstValueFrom(this.board.update(id, { flags: [...flags] }));
          } };
      }
      case 'propose': {
        const title = s(args['title']);
        if (!title || !ctx.project) throw new Error('propose needs { title } (and a project)');
        const description = s(args['description']);
        const kindOf = (s(args['kind']).toUpperCase() || 'TASK') as CardKind;
        if (!KINDS.includes(kindOf)) throw new Error(`propose's kind is one of ${KINDS.join(', ')}`);
        return { title: 'Add a card', lines: [`Add a ${kindOf.toLowerCase()} card "${title}" to the ${ctx.project} Inbox`], exact: description || undefined,
          confirm: 'Add the card', run: () => firstValueFrom(this.board.create({ project: ctx.project!, kind: kindOf, title, description,
            cycleId: ctx.cycleId ?? null })) };
      }
      case 'rule': {
        const c = callOf({ type: 'call', ref: s(args['call'] ?? args['ref']), label: '' } as MentionRef);
        if (!c) throw new Error('rule needs { call: "in:<id>" } - the call the rule starts from');
        return { title: 'Draft an interception rule', lines: ['Open the rule editor with a new rule started from this call', 'Nothing is saved until you save it there'],
          confirm: 'Open the editor', run: async () => {
            const call = await firstValueFrom(this.calls.getSummary(c.id, c.direction === 'in' ? 'internal' : 'external'));
            this.rules.start({ ...call, source: c.direction === 'in' ? 'internal' : 'external' });
            await this.router.navigate(['/interception']);
            return true;
          } };
      }
      case 'open-call': {
        const ref = s(args['call'] ?? args['ref']);
        if (!callOf({ type: 'call', ref, label: '' } as MentionRef)) throw new Error('open-call needs { call: "in:<id>" }');
        return { title: 'Open a call', lines: ['Open this call in the Calls view'], exact: ref, confirm: 'Open',
          run: async () => { this.mentions.open({ type: 'call', ref, label: ref } as MentionRef); return true; } };
      }
      default:
        throw new Error(`"${kind}" is not an action - use one of ${ACTION_KINDS.join(', ')}`);
    }
  }
}
