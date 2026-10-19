import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LinksApiService } from '../../../core/links/links-api.service';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { LinkRequest, Offer, RequestKind } from '../../../core/links/links.models';

const MAX_SHOWN = 3;

export function requestVerb(kind: RequestKind): string {
  switch (kind) {
    case 'CARD_COMMENT': return 'comment on';
    case 'CARD_QUESTION': return 'ask about';
    case 'BRIEF_COMMENT': return 'comment on the brief of';
    case 'CALL_NOTE': return 'note on';
  }
}

/**
 * The bottom-right stack every page shows (D3, D11-D14): an Alfred asking to link (with its one-time code), requests
 * waiting for this Alfred's answer (the first answer in any tab wins), auto-accepted ones with Undo, and the drafts kept
 * while an owner was offline. Nothing here polls: the lists come from {@link LinksStateService}.
 */
@Component({
  selector: 'app-links-tray',
  standalone: true,
  imports: [DatePipe, RouterLink],
  template: `
    @if (shown()) {
      <div class="lk-stack" role="region" aria-label="Links">
        @for (o of offers(); track o.id) {
          <div class="lk-req lk-req-link">
            <b>{{ o.fromName || 'An Alfred' }} wants to link</b>
            <div class="lk-small lk-dim">From {{ o.fromAddress || 'the LAN' }}@if (o.fromVersion) { · Alfred {{ o.fromVersion }} }.
              Every open tab of this Alfred shows this; anyone may accept.</div>
            <div class="lk-code" title="Check it matches the code shown on the other Alfred">{{ o.code }}</div>
            <div class="lk-row">
              <input class="lk-in" type="text" maxlength="40" [value]="nameFor(o)" (input)="names.set(o.id, $any($event.target).value)"
                     title="Your name for it - its pill and the tag in refs" placeholder="Your name for it" />
              <button type="button" class="lk-btn p" [disabled]="busy() === o.id || !nameFor(o).trim()" (click)="acceptOffer(o)">Accept</button>
              <button type="button" class="lk-btn" [disabled]="busy() === o.id" (click)="rejectOffer(o)">Decline</button>
            </div>
            <div class="lk-note">A link alone shares nothing.</div>
          </div>
        }
        @for (r of waiting(); track r.id) {
          <div class="lk-req">
            <div><b>{{ links.nameOf(slugOf(r)) }}{{ r.author ? ' · ' + r.author : '' }}</b> <span class="lk-dim">asks to {{ verb(r) }}</span>
              <span class="lk-target">{{ r.targetLabel || r.target }}</span></div>
            <div class="lk-diff">{{ r.text }}</div>
            <div class="lk-small lk-dim">{{ r.createdAt | date: 'HH:mm' }} · shown in every open tab, the first answer wins</div>
            @if (rejecting() === r.id) {
              <div class="lk-row">
                <input class="lk-in" type="text" maxlength="500" placeholder="Reason (they see it)" [value]="reason()" (input)="reason.set($any($event.target).value)"
                       (keydown.enter)="reject(r)" />
                <button type="button" class="lk-btn r" [disabled]="busy() === r.id" (click)="reject(r)">Reject</button>
                <button type="button" class="lk-btn" (click)="rejecting.set(null)">Back</button>
              </div>
            } @else {
              <div class="lk-row">
                <button type="button" class="lk-btn p" [disabled]="busy() === r.id" (click)="accept(r)">Accept</button>
                <button type="button" class="lk-btn" (click)="rejecting.set(r.id); reason.set('')">Reject…</button>
              </div>
            }
          </div>
        }
        @if (moreWaiting() > 0) {
          <a class="lk-req lk-more" routerLink="/settings" [queryParams]="{ section: 'links' }">+{{ moreWaiting() }} more waiting - Settings → Links</a>
        }
        @for (r of links.autoAccepted(); track r.id) {
          <div class="lk-req lk-req-auto">
            <span><b>{{ links.nameOf(slugOf(r)) }}</b> <span class="lk-dim">{{ verb(r) }} {{ r.targetLabel || r.target }} - accepted automatically</span></span>
            <div class="lk-row">
              <button type="button" class="lk-btn" [disabled]="busy() === r.id" (click)="undo(r)">Undo</button>
              <button type="button" class="lk-btn" (click)="links.dismissAuto(r.id)">OK</button>
            </div>
          </div>
        }
        @if (links.drafts().length) {
          <div class="lk-req lk-req-draft">
            <b>{{ links.drafts().length }} kept in this browser</b>
            <div class="lk-small lk-dim">Their Alfred was offline - they go out by themselves when it is back.</div>
            @for (d of links.drafts(); track d.id) {
              <div class="lk-draft">
                <span class="lk-small">{{ links.nameOf(d.request.via) }} · {{ d.request.text }}</span>
                @if (d.lastError) { <span class="lk-small lk-warn">{{ d.lastError }}</span> }
                <button type="button" class="lk-btn" (click)="links.discardDraft(d.id)" title="Drop it">✕</button>
              </div>
            }
            <button type="button" class="lk-btn" (click)="links.flushDrafts()">Send now</button>
          </div>
        }
        @if (error()) { <div class="lk-req lk-req-err" role="alert">{{ error() }} <button type="button" class="lk-btn" (click)="error.set(null)">OK</button></div> }
      </div>
    }`,
})
export class LinksTrayComponent {
  readonly links = inject(LinksStateService);
  private readonly api = inject(LinksApiService);

  readonly busy = signal<string | null>(null);
  readonly rejecting = signal<string | null>(null);
  readonly reason = signal('');
  readonly error = signal<string | null>(null);
  readonly names = new Map<string, string>();

  readonly offers = computed(() => this.links.offers().filter((o) => o.state === 'WAITING'));
  readonly waiting = computed(() => this.links.waiting().slice(0, MAX_SHOWN));
  readonly moreWaiting = computed(() => Math.max(0, this.links.waiting().length - MAX_SHOWN));
  readonly shown = computed(() => this.offers().length > 0 || this.links.waiting().length > 0 || this.links.autoAccepted().length > 0
    || this.links.drafts().length > 0 || !!this.error());

  constructor() {
    this.links.start();
  }

  verb(r: LinkRequest): string {
    return requestVerb(r.kind);
  }

  slugOf(r: LinkRequest): string | null {
    return this.links.linkById().get(r.linkId)?.slug ?? null;
  }

  nameFor(o: Offer): string {
    return this.names.get(o.id) ?? (o.fromName || '');
  }

  acceptOffer(o: Offer): void {
    this.busy.set(o.id);
    this.api.acceptOffer(o.id, this.nameFor(o).trim()).subscribe({
      next: () => this.done(),
      error: (e) => this.failed(e),
    });
  }

  rejectOffer(o: Offer): void {
    this.busy.set(o.id);
    this.api.rejectOffer(o.id).subscribe({ next: () => this.done(), error: (e) => this.failed(e) });
  }

  accept(r: LinkRequest): void {
    this.busy.set(r.id);
    this.links.accept(r.id).subscribe({ next: () => this.done(), error: (e) => this.failed(e) });
  }

  reject(r: LinkRequest): void {
    this.busy.set(r.id);
    this.links.reject(r.id, this.reason().trim() || null).subscribe({
      next: () => {
        this.rejecting.set(null);
        this.done();
      },
      error: (e) => this.failed(e),
    });
  }

  undo(r: LinkRequest): void {
    this.busy.set(r.id);
    this.links.undo(r.id).subscribe({ next: () => this.done(), error: (e) => this.failed(e) });
  }

  private done(): void {
    this.busy.set(null);
    this.links.reload();
  }

  private failed(e: unknown): void {
    this.busy.set(null);
    const p = problemOf(e);
    // another tab answered first: the list catches up by itself, nothing to report
    if (p.error === 'ANSWERED' || p.error === '409') {
      this.links.reload();
      return;
    }
    this.error.set(p.message || p.error);
  }
}
