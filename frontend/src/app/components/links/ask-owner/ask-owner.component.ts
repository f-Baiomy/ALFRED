import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { RequestKind, Stream, StreamKind } from '../../../core/links/links.models';
import { splitRef } from '../../../core/links/remote-ref';
import { requestVerb } from '../links-tray/links-tray.component';

/**
 * Writing on another Alfred's thing (specs/035 D10-D14): never a write here - a request its owner accepts or rejects.
 * One composer for a card (comment, or a question), a board's brief (a comment on the brief) and a call (a note). The
 * stream decides: view only says so; an offline owner gets it later from this browser (a draft). What this Alfred asked
 * and is still waiting for is listed under it, with Withdraw.
 */
@Component({
  selector: 'app-ask-owner',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="ao">
      @if (!stream()) {
        <div class="lk-small lk-dim">Streamed from {{ owner() }} - nothing here can be changed from this Alfred.</div>
      } @else if (stream()!.endedAt) {
        <div class="lk-small lk-dim">{{ owner() }} stopped streaming this.</div>
      } @else if (stream()!.mode !== 'COMMENT') {
        <div class="lk-small lk-dim">View only - {{ owner() }} can let you comment by changing the stream.</div>
      } @else {
        <textarea class="lk-in ao-text" rows="2" maxlength="20000" [placeholder]="placeholder()" [value]="text()"
                  (input)="text.set($any($event.target).value)" (keydown.control.enter)="send(primaryKind())" [attr.aria-label]="placeholder()"></textarea>
        <div class="lk-row">
          <button type="button" class="lk-btn p" [disabled]="!text().trim() || busy()" (click)="send(primaryKind())">{{ primaryLabel() }}</button>
          @if (kind() === 'card') {
            <button type="button" class="lk-btn" [disabled]="!text().trim() || busy()" (click)="send('CARD_QUESTION')" title="A question its owner answers">Ask</button>
          }
          <span class="lk-small lk-dim">a request to {{ owner() }}@if (stream()!.autoAccept) { - it takes them at once } @else { - it accepts or rejects it }@if (!online()) { · offline: kept in this browser until it is back }</span>
        </div>
        @if (note()) { <div class="lk-small" [class.lk-warn]="noteBad()">{{ note() }}</div> }
      }
      @for (r of mine(); track r.id) {
        <div class="ao-mine lk-small">
          <span class="lk-chip" [class.amber]="r.state === 'WAITING'" [class.ok]="r.state === 'ACCEPTED'" [class.off]="r.state === 'REJECTED' || r.state === 'UNDONE'">
            {{ r.state === 'WAITING' ? 'waiting' : r.state.toLowerCase() }}</span>
          <span class="ao-what">{{ verb(r.kind) }}: {{ r.text }}</span>
          @if (r.note) { <span class="lk-dim">“{{ r.note }}”</span> }
          <span class="lk-dim">{{ r.createdAt | date: 'HH:mm' }}</span>
          @if (r.state === 'WAITING') { <button type="button" class="board-link" (click)="withdraw(r.id)">Withdraw</button> }
        </div>
      }
      @for (d of drafts(); track d.id) {
        <div class="ao-mine lk-small"><span class="lk-chip off">kept here</span><span class="ao-what">{{ d.request.text }}</span>
          <button type="button" class="board-link" (click)="links.discardDraft(d.id)">Drop</button></div>
      }
    </div>`,
  styles: [`
    .ao { display: grid; gap: .35rem; margin: .4rem 0; }
    .ao-text { width: 100%; resize: vertical; box-sizing: border-box; }
    .ao-mine { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
    .ao-what { overflow-wrap: anywhere; }
  `],
})
export class AskOwnerComponent {
  readonly links = inject(LinksStateService);

  /** The thing written on, as this page has it: `<owner id>@<slug>` (a card, a board, a call). */
  readonly ref = input.required<string>();
  readonly kind = input.required<'card' | 'brief' | 'call'>();
  /** What the owner sees it is about: "#7 Refund total", "GET /refunds/7 → 500". */
  readonly label = input('');
  /** The stream it came over: a board stream for a card or a brief; for a call, its cycle's (or the board's). */
  readonly streamKind = input<StreamKind>('BOARD');
  /** The streamed thing's ref (the board, or the cycle) when it is not `ref` itself. */
  readonly streamRef = input<string | null>(null);
  /** Per-kind detail for the owner, as JSON (the brief passage, the call's cycle). */
  readonly extra = input<string | null>(null);

  readonly text = signal('');
  readonly busy = signal(false);
  readonly note = signal<string | null>(null);
  readonly noteBad = signal(false);

  private readonly split = computed(() => splitRef(this.ref()));
  readonly slug = computed(() => this.split()?.slug ?? null);
  readonly owner = computed(() => this.links.nameOf(this.slug()));
  readonly online = computed(() => !!this.links.linkOf(this.slug())?.online);
  readonly stream = computed<Stream | undefined>(() => {
    const link = this.links.linkOf(this.slug());
    const of = splitRef(this.streamRef() ?? this.ref());
    if (!link || !of) return undefined;
    const exact = this.links.givenStream(link.id, this.streamKind(), of.inner);
    if (exact) return exact;
    // a call of a cycle on a streamed board: the board's stream carries it
    return this.links.given().find((s) => s.linkId === link.id && s.kind === 'BOARD' && !s.endedAt);
  });
  readonly primaryKind = computed<RequestKind>(() => (this.kind() === 'card' ? 'CARD_COMMENT' : this.kind() === 'brief' ? 'BRIEF_COMMENT' : 'CALL_NOTE'));
  readonly primaryLabel = computed(() => (this.kind() === 'call' ? 'Note' : 'Comment'));
  readonly placeholder = computed(() => `${this.kind() === 'call' ? 'A note on this call' : this.kind() === 'brief' ? 'Comment on the brief'
    : 'Comment on this card'} - for ${this.owner()}`);
  readonly mine = computed(() => {
    const target = this.split()?.inner;
    return this.links.requests().filter((r) => !r.incoming && r.target === target && r.linkId === this.links.linkOf(this.slug())?.id).slice(0, 8);
  });
  readonly drafts = computed(() => {
    const target = this.split()?.inner;
    return this.links.drafts().filter((d) => d.request.via === this.slug() && d.request.target === target);
  });

  constructor() {
    this.links.start();
  }

  verb(kind: RequestKind): string {
    return requestVerb(kind);
  }

  send(kind: RequestKind): void {
    const s = this.stream();
    const split = this.split();
    const text = this.text().trim();
    if (!s || !split || !text) return;
    this.busy.set(true);
    this.note.set(null);
    this.links.send({ via: split.slug, streamId: s.id, kind, target: split.inner, targetLabel: this.label() || undefined, text,
      extra: this.extra() ?? undefined }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.text.set('');
        this.noteBad.set(false);
        this.note.set(r ? (r.state === 'ACCEPTED' ? `${this.owner()} took it.` : `Sent - waiting for ${this.owner()}.`)
          : `${this.owner()} is offline - kept in this browser, it goes out when it is back.`);
      },
      error: (e) => {
        this.busy.set(false);
        this.noteBad.set(true);
        this.note.set(problemOf(e).message);
      },
    });
  }

  withdraw(id: string): void {
    this.links.withdraw(id).subscribe({ error: (e) => { this.noteBad.set(true); this.note.set(problemOf(e).message); } });
  }
}
