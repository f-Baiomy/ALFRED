import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Discovered, Discovery, LinksApiService } from '../../../core/links/links-api.service';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { LinkInfo, LinkRequest, Pairing, ReadEntry, Stream } from '../../../core/links/links.models';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { StreamDialogService } from '../../../components/links/stream-dialog/stream-dialog.service';
import { OriginPillComponent } from '../../../components/links/origin-pill/origin-pill.component';
import { requestVerb } from '../../../components/links/links-tray/links-tray.component';

/**
 * Settings → Links & streams (specs/035 D1-D4, D22, D29, D30, D33): this Alfred's name on the LAN, the Alfreds it is
 * linked with and their health, linking one (found on the network or by address), what is streamed each way, the
 * requests, and the read log. A link alone shares nothing; nothing here is reachable through the tunnel.
 */
@Component({
  selector: 'app-links-settings',
  standalone: true,
  imports: [DatePipe, RouterLink, OriginPillComponent],
  template: `
    <section class="panel settings-panel lk-settings">
      <h3>Links &amp; streams <span class="sub">other Alfreds on the LAN</span></h3>
      <p class="sub">Other Alfreds this one is linked to, and what each side streams. A link alone shares nothing. Never through the tunnel.</p>
      @if (links.unavailable() && !links.loaded()) {
        <div class="board-error" role="alert">Links are not available here - opened through the tunnel, or this Alfred is too old.</div>
      }

      <!-- ------------------------------------------------------------------------------------------ this Alfred -->
      <div class="lk-lbl">This Alfred</div>
      @if (links.self(); as me) {
        <div class="lk-line">
          @if (editingSelf()) {
            <input class="lk-in" type="text" maxlength="60" [value]="selfName()" (input)="selfName.set($any($event.target).value)" (keydown.enter)="saveSelf()" />
            <button type="button" class="bulk-btn" [disabled]="!selfName().trim()" (click)="saveSelf()">Save</button>
            <button type="button" class="board-link" (click)="editingSelf.set(false)">Cancel</button>
          } @else {
            <b>{{ me.name }}</b><span class="board-dim"> Alfred {{ me.version }} · id {{ me.alfredId.slice(0, 8) }}</span>
            <button type="button" class="board-link" (click)="selfName.set(me.name); editingSelf.set(true)">Rename</button>
          }
        </div>
        <label class="lk-check">
          <input type="checkbox" [checked]="me.announce" (change)="setAnnounce($any($event.target).checked)" />
          Announce this Alfred on the LAN as <b>"{{ me.name }}"</b><span class="board-dim"> (name, address and version only; it never links by itself)</span>
        </label>
      }

      <!-- ------------------------------------------------------------------------------------------ linked -->
      <div class="lk-lbl">Linked Alfreds</div>
      @for (l of links.links(); track l.id) {
        <div class="lk-line lk-link">
          @if (renaming() === l.id) {
            <input class="lk-in" type="text" maxlength="40" [value]="draftName()" (input)="draftName.set($any($event.target).value)" (keydown.enter)="rename(l)" />
            <button type="button" class="bulk-btn" [disabled]="!draftName().trim()" (click)="rename(l)">Save</button>
            <button type="button" class="board-link" (click)="renaming.set(null)">Cancel</button>
          } @else {
            <b>{{ l.name }}</b>
          }
          <span class="board-dim lk-small" [title]="'Its refs carry @' + l.slug">
            @if (readdressing() === l.id) {
              <input class="lk-in" type="text" [value]="draftAddress()" (input)="draftAddress.set($any($event.target).value)" (keydown.enter)="readdress(l)" />
              <button type="button" class="bulk-btn" [disabled]="!draftAddress().trim()" (click)="readdress(l)">Save</button>
              <button type="button" class="board-link" (click)="readdressing.set(null)">Cancel</button>
            } @else {
              {{ l.address || 'it dials this one' }}
            }
            @if (l.peerName) { · calls itself "{{ l.peerName }}" } · &#64;{{ l.slug }} · linked {{ l.createdAt | date: 'd MMM' }}
          </span>
          <span class="lk-sp"></span>
          <span class="lk-small board-dim" title="Link health">
            @if (l.online) {
              @if (l.rttMs !== null) { {{ l.rttMs }} ms · } v{{ l.peerVersion || '?' }}@if (l.inFlight) { · {{ l.inFlight }} reads }
            } @else {
              last seen {{ l.lastSeen ? (l.lastSeen | date: 'd MMM HH:mm') : 'never' }} · v{{ l.peerVersion || '?' }}
            }
          </span>
          @if (l.online) { <span class="lk-chip ok">● connected</span> } @else { <span class="lk-chip off" [title]="l.lastError || ''">offline</span> }
          <button type="button" class="board-link" (click)="draftName.set(l.name); renaming.set(l.id)">Rename</button>
          @if (l.dialer) { <button type="button" class="board-link" (click)="draftAddress.set(l.address || ''); readdressing.set(l.id)">Address</button> }
          <button type="button" class="board-link danger" (click)="unlink(l)">Unlink</button>
        </div>
        @if (!l.online && l.lastError) { <div class="lk-small lk-warn lk-indent">{{ l.lastError }}</div> }
        @if (l.skewed) { <div class="lk-small lk-warn lk-indent">Its clock is {{ skew(l) }} off this one's - re-test windows and "after the fix" may be off.</div> }
      } @empty {
        <div class="board-dim">Not linked to any Alfred.</div>
      }

      @for (p of openPairings(); track p.id) {
        <div class="lk-line lk-pairing">
          <span>Linking <b>{{ p.name }}</b><span class="board-dim"> {{ p.address }}</span></span>
          @if (p.state === 'WAITING') {
            <span class="lk-small">waiting for someone there to accept - check it shows</span>&nbsp;<span class="lk-code">{{ p.code }}</span>
            <span class="lk-sp"></span>
            <button type="button" class="board-link" (click)="cancelPairing(p)">Cancel</button>
          } @else {
            <span class="lk-small" [class.lk-warn]="p.state !== 'LINKED'">{{ pairingText(p) }}</span>
            <span class="lk-sp"></span>
            <button type="button" class="board-link" (click)="dismissPairing(p)">OK</button>
          }
        </div>
      }

      <!-- ------------------------------------------------------------------------------------------ discovery -->
      <div class="lk-lbl">Found on this network <span class="board-dim">- Alfreds announcing themselves on the LAN</span>
        <button type="button" class="board-link" (click)="loadDiscovery()" title="Look again">↻</button></div>
      @if (discovery(); as d) {
        @if (!d.available) {
          <div class="lk-small board-dim">{{ d.why || 'LAN discovery is not available here.' }}</div>
        } @else {
          @for (f of unlinkedFound(); track f.alfredId) {
            <div class="lk-line">
              <span class="lk-dot" aria-hidden="true"></span><b>{{ f.name }}</b>
              <span class="board-dim lk-small">{{ f.address }} · Alfred {{ f.version || '?' }}</span>
              <span class="lk-sp"></span>
              <button type="button" class="bulk-btn" (click)="pickFound(f)">Link…</button>
            </div>
          } @empty {
            <div class="lk-small board-dim">No unlinked Alfred is announcing right now.</div>
          }
        }
      } @else {
        <div class="lk-small board-dim">Looking…</div>
      }

      <div class="lk-lbl">Or type an address <span class="board-dim">- another subnet, a VPN</span></div>
      <div class="lk-line">
        <input class="lk-in lk-wide" type="text" placeholder="http://10.0.0.83:3000" [value]="address()" (input)="address.set($any($event.target).value)" />
        <input class="lk-in" type="text" maxlength="40" placeholder="Your name for it, e.g. QA server" [value]="newName()" (input)="newName.set($any($event.target).value)"
               (keydown.enter)="pair()" />
        <button type="button" class="bulk-btn" [disabled]="!address().trim() || !newName().trim() || busy()" (click)="pair()">Link</button>
      </div>
      <div class="lk-note">Your name for it becomes its pill (<span class="lk-chip cyan">⇇ name</span>) and the tag in refs (<code>&lt;id&gt;&#64;name</code>) - the
        tag stays even if you rename it later. The other Alfred shows a one-time code; anyone using it accepts.</div>

      <!-- ------------------------------------------------------------------------------------------ streams out -->
      <div class="lk-lbl">Streamed from here</div>
      @if (offeredActive().length) {
        <table class="lk-table">
          <thead><tr><th>What</th><th>To</th><th>They may</th><th>Auto-accept</th><th>Pass on</th><th>Secrets</th><th>Since</th><th>Open now</th><th></th></tr></thead>
          <tbody>
            @for (s of offeredActive(); track s.id) {
              <tr>
                <td>{{ s.kind === 'BOARD' ? '▦' : '◷' }} {{ s.targetName || s.target }}@if (s.env) { <span class="lk-chip amber">🧪 {{ s.env }}</span> }</td>
                <td>{{ links.linkById().get(s.linkId)?.name || '?' }}</td>
                <td>{{ s.mode === 'COMMENT' ? 'comment' : 'view' }}</td>
                <td>{{ s.mode === 'COMMENT' && s.autoAccept ? 'on' : 'off' }}</td>
                <td>{{ s.passOn ? 'yes · ' + (s.passMode === 'COMMENT' ? 'comment' : 'view') : 'no' }}</td>
                <td>@if (s.unmasked) { <span class="lk-warn">unmasked</span> } @else { masked }</td>
                <td class="board-dim">{{ s.createdAt | date: 'd MMM HH:mm' }}</td>
                <td>{{ viewers(s) || '' }}</td>
                <td class="lk-acts">
                  <button type="button" class="board-link" (click)="change(s)">Change</button>
                  <button type="button" class="board-link danger" (click)="stop(s)">Stop</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="board-dim">Nothing streamed from here. Stream a cycle from the Session Cycles page, or a board from its header.</div>
      }

      <!-- ------------------------------------------------------------------------------------------ streams in -->
      <div class="lk-lbl">Streamed to here</div>
      @if (links.given().length) {
        <table class="lk-table">
          <thead><tr><th>What</th><th>From</th><th>You may</th><th>State</th><th>Since</th><th></th></tr></thead>
          <tbody>
            @for (s of links.given(); track s.id) {
              <tr>
                <td>{{ s.kind === 'BOARD' ? '▦' : '◷' }} {{ s.targetName || s.target }}@if (s.env) { <span class="lk-chip amber">🧪 {{ s.env }}</span> }</td>
                <td><app-origin-pill [ref]="refOf(s)" [kind]="s.kind" /></td>
                <td>{{ s.mode === 'COMMENT' ? 'comment' : 'view' }}</td>
                <td>
                  @if (s.endedAt) { <span class="lk-chip off">stream ended</span> }
                  @else if (links.linkById().get(s.linkId)?.online) { <span class="lk-chip ok">● live</span> }
                  @else { <span class="lk-chip off">offline</span> }
                </td>
                <td class="board-dim">{{ s.createdAt | date: 'd MMM HH:mm' }}</td>
                <td class="lk-acts">
                  @if (!s.endedAt) {
                    @if (s.kind === 'CYCLE') { <a class="board-link" [routerLink]="['/cycles', refOf(s)]">Open</a> }
                    @else { <a class="board-link" routerLink="/board" [queryParams]="{ board: refOf(s), project: s.project }">Open</a> }
                  } @else {
                    <button type="button" class="board-link" (click)="forget(s)">Remove</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="board-dim">Nothing is streamed to this Alfred.</div>
      }

      <!-- ------------------------------------------------------------------------------------------ requests -->
      <div class="lk-lbl">Requests <span class="board-dim">- comments, questions and notes asked for over a stream</span></div>
      @if (recentRequests().length) {
        <table class="lk-table">
          <thead><tr><th>When</th><th>Who</th><th>Asks to</th><th>Text</th><th>State</th><th></th></tr></thead>
          <tbody>
            @for (r of recentRequests(); track r.id) {
              <tr>
                <td class="board-dim">{{ r.createdAt | date: 'd MMM HH:mm' }}</td>
                <td>{{ r.incoming ? (linkName(r) + (r.author ? ' · ' + r.author : '')) : 'you → ' + linkName(r) }}</td>
                <td>{{ verb(r) }} {{ r.targetLabel || r.target }}</td>
                <td class="lk-text">{{ r.text }}@if (r.note) { <div class="lk-small board-dim">“{{ r.note }}”</div> }</td>
                <td><span class="lk-chip" [class.ok]="r.state === 'ACCEPTED'" [class.off]="r.state !== 'ACCEPTED' && r.state !== 'WAITING'"
                          [class.amber]="r.state === 'WAITING'">{{ stateText(r) }}</span></td>
                <td class="lk-acts">
                  @if (r.incoming && r.state === 'WAITING') {
                    <button type="button" class="board-link" (click)="accept(r)">Accept</button>
                    <button type="button" class="board-link danger" (click)="reject(r)">Reject</button>
                  } @else if (r.incoming && r.state === 'ACCEPTED') {
                    <button type="button" class="board-link" (click)="undo(r)">Undo</button>
                  } @else if (!r.incoming && r.state === 'WAITING') {
                    <button type="button" class="board-link" (click)="withdraw(r)">Withdraw</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="board-dim">No requests yet.</div>
      }

      <!-- ------------------------------------------------------------------------------------------ read log -->
      <div class="lk-lbl">Read log <span class="board-dim">- what other Alfreds opened or exported from here, per day</span>
        <select class="lk-in lk-sel" [value]="readsLink()" (change)="readsLink.set($any($event.target).value); loadReads()">
          <option value="">every link</option>
          @for (l of links.links(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
        </select>
      </div>
      @if (reads().length) {
        <table class="lk-table">
          <thead><tr><th>Day</th><th>Who</th><th>What</th><th>Times</th><th>Last</th></tr></thead>
          <tbody>
            @for (r of reads(); track r.linkId + r.family + r.target + r.day + r.via) {
              <tr>
                <td class="board-dim">{{ r.day }}</td>
                <td>{{ links.linkById().get(r.linkId)?.name || '?' }}@if (r.via) { <span class="board-dim"> for {{ r.via }}</span> }</td>
                <td>{{ r.family }} <code>{{ r.target }}</code></td>
                <td>{{ r.count }}</td>
                <td class="board-dim">{{ r.lastAt | date: 'HH:mm' }}</td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="board-dim">Nothing read yet. Opening a call or a card, or exporting, from another Alfred shows up here.</div>
      }

      @if (error()) { <div class="board-error" role="alert">{{ error() }}</div> }
    </section>`,
})
export class LinksSettingsComponent implements OnInit {
  readonly links = inject(LinksStateService);
  private readonly api = inject(LinksApiService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly streamDialog = inject(StreamDialogService);

  readonly editingSelf = signal(false);
  readonly selfName = signal('');
  readonly renaming = signal<string | null>(null);
  readonly draftName = signal('');
  readonly readdressing = signal<string | null>(null);
  readonly draftAddress = signal('');
  readonly address = signal('');
  readonly newName = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly discovery = signal<Discovery | null>(null);
  readonly reads = signal<ReadEntry[]>([]);
  readonly readsLink = signal('');

  readonly openPairings = computed(() => this.links.pairings().filter((p) => p.state !== 'CANCELLED'));
  readonly unlinkedFound = computed(() => (this.discovery()?.found ?? []).filter((f) => !f.linkedSlug));
  readonly offeredActive = computed(() => this.links.offered().filter((s) => !s.endedAt));
  readonly recentRequests = computed(() => this.links.requests().slice(0, 60));

  ngOnInit(): void {
    this.links.start();
    this.loadDiscovery();
    this.loadReads();
  }

  loadDiscovery(): void {
    this.api.discovered().subscribe({
      next: (d) => this.discovery.set(d),
      error: () => this.discovery.set({ available: false, why: 'LAN discovery could not be asked', announcing: false, found: [] }),
    });
  }

  loadReads(): void {
    this.api.reads(this.readsLink() || null, 7).subscribe({ next: (r) => this.reads.set(r), error: () => this.reads.set([]) });
  }

  // ---------------------------------------------------------------------------------------------------- self
  saveSelf(): void {
    const name = this.selfName().trim();
    if (!name) return;
    this.api.updateSelf({ name }).subscribe({
      next: (s) => {
        this.links.self.set(s);
        this.editingSelf.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  setAnnounce(on: boolean): void {
    this.api.updateSelf({ announce: on }).subscribe({
      next: (s) => {
        this.links.self.set(s);
        this.loadDiscovery();
      },
      error: (e) => this.fail(e),
    });
  }

  // ---------------------------------------------------------------------------------------------------- links
  rename(l: LinkInfo): void {
    const name = this.draftName().trim();
    if (!name) return;
    this.api.rename(l.id, name).subscribe({ next: () => this.ok(() => this.renaming.set(null)), error: (e) => this.fail(e) });
  }

  readdress(l: LinkInfo): void {
    const a = this.draftAddress().trim();
    if (!a) return;
    this.api.readdress(l.id, a).subscribe({ next: () => this.ok(() => this.readdressing.set(null)), error: (e) => this.fail(e) });
  }

  async unlink(l: LinkInfo): Promise<void> {
    const sure = await this.confirm.confirm(`Unlink ${l.name}? Every stream between the two Alfreds ends at once, both ways; boards keep the names `
      + `of its cycles. Linking again later keeps "@${l.slug}".`, 'Unlink');
    if (!sure) return;
    this.api.unlink(l.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  pickFound(f: Discovered): void {
    this.address.set(f.address);
    this.newName.set(f.name);
  }

  pair(): void {
    const address = this.address().trim();
    const name = this.newName().trim();
    if (!address || !name) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.pair(address, name).subscribe({
      next: () => {
        this.busy.set(false);
        this.address.set('');
        this.newName.set('');
        this.links.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e);
      },
    });
  }

  cancelPairing(p: Pairing): void {
    this.api.cancelPairing(p.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  dismissPairing(p: Pairing): void {
    this.api.dismissPairing(p.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  pairingText(p: Pairing): string {
    switch (p.state) {
      case 'LINKED': return 'linked';
      case 'REJECTED': return 'they declined';
      case 'EXPIRED': return 'nobody accepted in time';
      case 'FAILED': return p.message || 'could not reach it';
      default: return p.message || p.state.toLowerCase();
    }
  }

  skew(l: LinkInfo): string {
    const ms = Math.abs(l.clockOffsetMs ?? 0);
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
  }

  // -------------------------------------------------------------------------------------------------- streams
  refOf(s: Stream): string {
    const slug = this.links.linkById().get(s.linkId)?.slug;
    return slug ? `${s.target}@${slug}` : s.target;
  }

  viewers(s: Stream): number {
    return this.links.presence().filter((p) => p.linkId === s.linkId && p.target === s.target).reduce((n, p) => n + p.viewers, 0);
  }

  change(s: Stream): void {
    this.streamDialog.open({ kind: s.kind, target: s.target, name: s.targetName || s.target, project: s.project });
  }

  async stop(s: Stream): Promise<void> {
    const to = this.links.linkById().get(s.linkId)?.name ?? 'the other Alfred';
    const sure = await this.confirm.confirm(`Stop streaming "${s.targetName || s.target}" to ${to}? It shows "stream ended" there at once.`, 'Stop');
    if (!sure) return;
    this.api.stopStream(s.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  forget(s: Stream): void {
    this.api.stopStream(s.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  // ------------------------------------------------------------------------------------------------- requests
  linkName(r: LinkRequest): string {
    return this.links.linkById().get(r.linkId)?.name ?? '?';
  }

  verb(r: LinkRequest): string {
    return requestVerb(r.kind);
  }

  stateText(r: LinkRequest): string {
    const s = r.state.toLowerCase();
    return r.auto && r.state === 'ACCEPTED' ? 'accepted · auto' : s;
  }

  accept(r: LinkRequest): void {
    this.links.accept(r.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  reject(r: LinkRequest): void {
    this.links.reject(r.id, null).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  undo(r: LinkRequest): void {
    this.links.undo(r.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  withdraw(r: LinkRequest): void {
    this.links.withdraw(r.id).subscribe({ next: () => this.ok(), error: (e) => this.fail(e) });
  }

  private ok(then?: () => void): void {
    this.error.set(null);
    then?.();
    this.links.reload();
  }

  private fail(e: unknown): void {
    const p = problemOf(e);
    this.error.set(p.message || p.error);
  }
}
