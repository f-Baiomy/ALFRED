import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { CardItem, CardMatch, Markers, WriteBundle, closedCategory } from '../../../core/team/team.models';
import { ChatApiService } from '../../../core/services/chat-api.service';

import { TeamItemDrawerComponent } from '../item-drawer/item-drawer.component';
import { TeamConsentBundleComponent } from '../consent-bundle/consent-bundle.component';

/** Fields the tracker keeps itself, or that are set another way (state, type) - never offered for a direct edit. */
const KEPT = new Set(['system.state', 'system.id', 'system.rev', 'system.changeddate', 'system.createddate', 'system.changedby', 'system.createdby',
  'system.authorizeddate', 'system.reviseddate', 'system.watermark', 'system.workitemtype', 'system.teamproject', 'system.history',
  'system.authorizedas', 'system.personid', 'system.nodename', 'system.areaid', 'system.iterationid', 'system.boardcolumndone',
  'system.commentcount', 'system.reason']);

/** The fields of an item a person may set from the card (specs/030 FR-016): every field Azure sent but the kept ones, by name. */
export function editableFields(fields: Readonly<Record<string, string>>): { name: string; label: string; value: string }[] {
  return Object.entries(fields)
    .filter(([k]) => /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(k) && !KEPT.has(k.toLowerCase()) && !k.toLowerCase().startsWith('system.extension'))
    .map(([k, v]) => ({ name: k, label: k.split('.').pop()!.replace(/([a-z])([A-Z])/g, '$1 $2') + ' (' + k + ')', value: v ?? '' }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A card's "Linked in Azure" (specs/028 US3 FR-057..064): the work items this card is linked to - many to many - each from
 * Alfred's saved copy (opened live on click), changed / closed-in-the-tracker badges, the tracker's comments, Link another
 * and Create in Azure, and the consent bundles waiting for this card.
 */
@Component({
  selector: 'app-team-card-items',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, TeamItemDrawerComponent, TeamConsentBundleComponent],
  template: `
    @if (items().length || bundles().length || state.connections().length) {
      <div class="tci">
        <div class="tci-head"><h5>Linked in {{ state.ui().label }}</h5>
          @if (editable() && state.picked()) {
            <button type="button" class="board-link" (click)="mode.set(mode() === 'link' ? null : 'link')">+ link</button>
            <button type="button" class="board-link" (click)="openCreate()">+ create in {{ state.ui().label }}</button>
          }
        </div>
        @for (i of items(); track i.conn + i.item) {
          <div class="tci-item" [class.closed]="closedCategory(i.stateCategory)">
            <button type="button" class="tci-open" (click)="opened.set(i)" title="Open it live">
              <span class="tci-dim">{{ i.type }} {{ i.item }}</span> {{ i.title }}</button>
            <span class="tci-state">{{ i.state }}</span>
            @if (i.closedInAzure) { <span class="tci-warn" title="Closed in the tracker - the card got a proposal">closed in {{ state.ui().label }}</span> }
            @if (i.changed) { <span class="tci-warn" title="Changed since the saved copy">● changed</span> }
            @if (i.comments.length) { <button type="button" class="board-link" (click)="toggleComments(i)">💬 {{ i.comments.length }}</button> }
            @if (editable()) {
              <button type="button" class="board-link" [attr.aria-expanded]="panel() === i.conn + i.item"
                      [title]="'Write to ' + state.ui().label + ' yourself, or draft it with Claude'" (click)="togglePanel(i)">{{ state.ui().label }} ▾</button>
              <button type="button" class="tci-x" title="Unlink from this card" (click)="unlink(i)">✕</button>
            }
          </div>
          @if (panel() === i.conn + i.item) {
            <div class="tci-panel">
              <span class="tci-dim">Write it yourself - sent now with your token:</span>
              <form class="tci-form" (submit)="$event.preventDefault(); sendComment(i)">
                <textarea [(ngModel)]="comment" name="comment" rows="2" placeholder="A comment on {{ i.type }} {{ i.item }}" aria-label="Comment"></textarea>
                <button type="submit" class="action-btn" [disabled]="!comment.trim() || busy()">Comment</button>
              </form>
              <form class="tci-form" (submit)="$event.preventDefault(); sendState(i)">
                <label class="tci-dim">State <select [(ngModel)]="newState" name="state" aria-label="State">
                  @for (s of statesOf(i.type); track s) { <option [value]="s">{{ s }}</option> }</select></label>
                <button type="submit" class="action-btn" [disabled]="!newState || newState === i.state || busy()">Set state</button>
              </form>
              <form class="tci-form" (submit)="$event.preventDefault(); sendField(i)">
                <label class="tci-dim">Field <select [(ngModel)]="field" name="field" aria-label="Field" (ngModelChange)="pickField($event)">
                  <option value="">Pick a field…</option>
                  @for (f of fields(); track f.name) { <option [value]="f.name">{{ f.label }}</option> }</select></label>
                <input [(ngModel)]="fieldValue" name="fieldValue" aria-label="Value" placeholder="New value (empty clears it)" [disabled]="!field" />
                <button type="submit" class="action-btn" [disabled]="!field || busy()">Set field</button>
              </form>
              <span class="tci-dim">Or</span>
              <div class="tci-row">
                <button type="button" class="action-btn" [disabled]="!canDraft() || busy()" (click)="draftWithClaude()"
                        [title]="canDraft() ? 'Posts /alfred-team update card #' + cardNumber() + ' to the board chat - Claude drafts a comment and state as a bundle you approve'
                          : 'Open this card from its board to ask Claude'">Draft with Claude</button>
                <span class="tci-dim">comment + state from the card's thread, as a bundle you approve</span>
              </div>
            </div>
          }
          @if (showComments() === i.conn + i.item) {
            @for (c of i.comments; track c.id) {
              <div class="tci-comment"><span class="tci-dim">from {{ state.ui().label }} · {{ c.by }} · {{ c.at?.slice(0, 16)?.replace('T', ' ') }}</span>
                <div>{{ plain(c.text) }}</div></div>
            }
          }
        } @empty {
          @if (matches().length) {
            <div class="tci-matches">
              <span class="tci-dim">Looks like an item in {{ state.ui().label }}:</span>
              @for (m of shownMatches(); track m.row.conn + m.row.item) {
                <div class="tci-match">
                  <button type="button" class="tci-open" (click)="opened.set({ conn: m.row.conn, item: m.row.item })" title="Open it live">
                    <span class="tci-dim">{{ m.type }} {{ m.row.item }}</span> {{ m.title }}</button>
                  @if (m.state) { <span class="tci-state">{{ m.state }}</span> }
                  @if (m.row.why) { <div class="tci-why">{{ m.row.why }}</div> }
                  @if (editable()) {
                    <div class="tci-row">
                      <button type="button" class="action-btn primary" [disabled]="busy()" (click)="linkMatch(m.row.conn, m.row.item)">Link</button>
                      <button type="button" class="action-btn" [disabled]="busy()" (click)="rejectMatch(m.row.conn, m.row.item)">Not this one</button>
                    </div>
                  }
                </div>
              }
              @if (matches().length > 1 && !allMatches()) {
                <button type="button" class="board-link" (click)="allMatches.set(true)">Show others ({{ matches().length - 1 }})</button>
              }
              <span class="tci-dim">None is right? "+ create in {{ state.ui().label }}" prepares a bundle that creates it under the board's main item.</span>
            </div>
          } @else { <span class="tci-dim">Not linked to a work item.</span> }
        }

        @if (mode() === 'link') {
          <form class="tci-form" (submit)="$event.preventDefault(); link()">
            <input [(ngModel)]="ref" name="ref" placeholder="Work item id, AB#id or URL" aria-label="Work item" />
            <ng-container *ngTemplateOutlet="markersBox" />
            <button type="submit" class="action-btn primary" [disabled]="!ref.trim()">Link</button>
            <button type="button" class="action-btn" (click)="mode.set(null)">Cancel</button>
          </form>
        }
        @if (mode() === 'create') {
          <form class="tci-form tci-create" (submit)="$event.preventDefault(); create()">
            <label>Type <select [(ngModel)]="type" name="type">@for (t of types(); track t) { <option [value]="t">{{ t }}</option> }</select></label>
            <label>Title <input [(ngModel)]="title" name="title" required maxlength="255" /></label>
            <label>Description <textarea [(ngModel)]="description" name="description" rows="4"></textarea></label>
            <label>{{ state.ui().word('area') }} <select [(ngModel)]="area" name="area"><option value="">Default</option>
              @for (a of state.lists()?.areas ?? []; track a) { <option [value]="a">{{ a }}</option> }</select></label>
            <label>{{ state.ui().word('sprint') }} <select [(ngModel)]="iteration" name="iteration"><option value="">None</option>
              @for (s of state.lists()?.iterations ?? []; track s.extId) { <option [value]="s.name">{{ s.name }}</option> }</select></label>
            <ng-container *ngTemplateOutlet="markersBox" />
            <span class="tci-dim">This prepares a bundle: the new item and the markers are written only when you approve it below.</span>
            <div class="tci-row"><button type="submit" class="action-btn primary" [disabled]="!title.trim() || !type || busy()">Create</button>
              <button type="button" class="action-btn" (click)="mode.set(null)">Cancel</button></div>
          </form>
        }
        <ng-template #markersBox>
          <span class="tci-marks" title="Asked as a bundle - nothing is written before you approve">Also tell {{ state.ui().label }}:
            <label><input type="checkbox" [(ngModel)]="markers.hyperlink" name="mh" /> link back</label>
            <label><input type="checkbox" [(ngModel)]="markers.comment" name="mc" /> comment</label>
            <label><input type="checkbox" [(ngModel)]="markers.tag" name="mt" /> tag</label></span>
        </ng-template>

        @for (w of openBundles(); track w.id) { <app-team-consent-bundle [bundle]="w" [editable]="editable()" (changed)="loadBundles()" /> }
        @if (doneBundles().length) {
          <details class="tci-done"><summary class="tci-dim">{{ doneBundles().length }} earlier bundle(s)</summary>
            @for (w of doneBundles(); track w.id) { <app-team-consent-bundle [bundle]="w" [editable]="false" /> }
          </details>
        }
        @if (message()) { <div class="tci-msg" [class.err]="isError()">{{ message() }}</div> }
      </div>
    }
    @if (opened(); as o) {
      <app-team-item-drawer [conn]="o.conn" [itemId]="o.item" (closed)="opened.set(null)" (openOther)="opened.set({ conn: o.conn, item: $event })" />
    }`,
  styles: [`
    .tci { display: grid; gap: .3rem; margin: .4rem 0; font-size: .82rem; }
    .tci-head { display: flex; gap: .5rem; align-items: center; }
    .tci-head h5 { margin: 0; }
    .tci-item { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; padding: .2rem .4rem; border: 1px solid var(--border); border-radius: 6px; }
    .tci-item.closed { opacity: .65; }
    .tci-open { border: 0; background: none; color: inherit; padding: 0; text-align: left; cursor: pointer; }
    .tci-dim { color: var(--text-dim); font-size: .76rem; }
    .tci-state { padding: 0 .3rem; border-radius: 4px; background: var(--card-inner); font-size: .74rem; }
    .tci-warn { color: var(--amber); font-size: .74rem; }
    .tci-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; margin-left: auto; }
    .tci-comment { margin-left: 1rem; padding: .2rem .4rem; border-left: 2px solid var(--border-strong); white-space: pre-wrap; }
    .tci-form { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
    .tci-create { display: grid; }
    .tci-create label { display: grid; gap: .15rem; font-size: .76rem; color: var(--text-dim); }
    .tci-form input, .tci-form select, .tci-form textarea { padding: .25rem .4rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner);
      color: var(--text); font: inherit; }
    .tci-marks { display: inline-flex; flex-wrap: wrap; gap: .35rem; align-items: center; font-size: .76rem; color: var(--text-dim); }
    .tci-marks label { display: inline-flex !important; gap: .2rem; align-items: center; }
    .tci-row { display: flex; gap: .35rem; }
    .tci-panel { display: grid; gap: .3rem; margin-left: 1rem; padding: .35rem .5rem; border-left: 2px solid var(--border-strong); }
    .tci-matches { display: grid; gap: .3rem; }
    .tci-match { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; padding: .3rem .45rem; border: 1px dashed var(--border-strong); border-radius: 6px; }
    .tci-why { flex-basis: 100%; color: var(--text-dim); font-size: .76rem; }
    .tci-msg { color: var(--green); font-size: .78rem; }
    .tci-msg.err { color: var(--red); }
  `],
})
export class TeamCardItemsComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  readonly closedCategory = closedCategory;

  readonly cardId = input.required<string>();
  readonly cardTitle = input('');
  readonly cardDescription = input('');
  /** The card's number, board and project - "Draft with Claude" posts to that board's chat. */
  readonly cardNumber = input<number | null>(null);
  readonly boardId = input<string | null>(null);
  readonly project = input<string | null>(null);
  readonly editable = input(true);
  /** The card's linked items, for "Also post to the tracker" on the card's comment box. */
  readonly linked = output<CardItem[]>();

  readonly items = signal<CardItem[]>([]);
  /** Items Alfred proposes for a card with none (specs/030 D6), best first. */
  readonly matches = signal<CardMatch[]>([]);
  readonly allMatches = signal(false);
  readonly shownMatches = computed(() => (this.allMatches() ? this.matches() : this.matches().slice(0, 1)));
  /** The linked item whose Azure panel is open ("<conn><item>"). */
  readonly panel = signal<string | null>(null);
  readonly canDraft = computed(() => !!this.cardNumber() && !!this.boardId() && this.project() !== null);
  private readonly chatApi = inject(ChatApiService);
  comment = '';
  newState = '';
  /** The open item's fields that a person may set (specs/030), by reference name, with their value now. */
  readonly fields = signal<{ name: string; label: string; value: string }[]>([]);
  field = '';
  fieldValue = '';
  readonly bundles = signal<WriteBundle[]>([]);
  readonly openBundles = computed(() => this.bundles().filter((b) => b.state === 'WAITING' || b.state === 'SENDING'));
  readonly doneBundles = computed(() => this.bundles().filter((b) => b.state !== 'WAITING' && b.state !== 'SENDING'));
  readonly mode = signal<'link' | 'create' | null>(null);
  readonly opened = signal<{ conn: string; item: string } | null>(null);
  readonly showComments = signal<string | null>(null);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  readonly types = computed(() => (this.state.lists()?.types ?? []).filter((t) => !/^(epic|feature)$/i.test(t)));
  ref = '';
  markers: Markers = { hyperlink: true, comment: false, tag: false };
  type = '';
  title = '';
  description = '';
  area = '';
  iteration = '';

  constructor() {
    if (!this.state.loaded()) this.state.load();
    effect(() => {
      const id = this.cardId();
      untracked(() => {
        this.items.set([]);
        this.linked.emit([]);
        this.load(id);
        this.loadBundles();
      });
    });
    effect(() => {
      const e = this.state.boardEvent();
      if (!e) return;
      if ((e.what === 'cards' && (!e['card'] || e['card'] === this.cardId())) || e.what === 'sync') untracked(() => this.load(this.cardId()));
      if (e.what === 'write' && (!e['card'] || e['card'] === this.cardId())) untracked(() => this.loadBundles());
      if (e.what === 'matches' && (!e['card'] || e['card'] === this.cardId())) untracked(() => this.loadMatches(this.cardId()));
    });
  }

  private load(id: string): void {
    this.api.cardItems(id).subscribe({
      next: (i) => {
        if (this.cardId() !== id) return;
        this.items.set(i);
        this.linked.emit(i);
        if (!i.length) this.loadMatches(id); else this.matches.set([]);
      },
      error: () => {
        if (this.cardId() !== id) return;
        this.items.set([]);
        this.linked.emit([]);
      },
    });
  }

  loadMatches(id: string): void {
    this.api.cardMatches(id).subscribe({ next: (m) => this.cardId() === id && this.matches.set(m), error: () => this.matches.set([]) });
  }

  linkMatch(conn: string, item: string): void {
    this.busy.set(true);
    this.api.linkMatch(this.cardId(), conn, item).subscribe({
      next: (items) => {
        this.busy.set(false);
        this.items.set(items);
        this.linked.emit(items);
        this.matches.set([]);
        this.say(`Linked - Alfred keeps a copy of item ${item}. Nothing was written to ${this.state.ui().label}.`);
      },
      error: (e) => { this.busy.set(false); this.say(e?.error?.message || 'Could not link it', true); },
    });
  }

  rejectMatch(conn: string, item: string): void {
    this.api.rejectMatch(this.cardId(), conn, item).subscribe({
      next: (m) => { this.matches.set(m); this.say(`Item ${item} will not be proposed for this card again.`); },
      error: (e) => this.say(e?.error?.message || 'Could not reject it', true),
    });
  }

  togglePanel(i: CardItem): void {
    const k = i.conn + i.item;
    this.panel.set(this.panel() === k ? null : k);
    this.comment = '';
    this.newState = i.state ?? '';
    this.field = '';
    this.fieldValue = '';
    this.fields.set([]);
    if (this.panel()) {
      this.api.item(i.conn, i.item, '').subscribe({ next: (v) => this.fields.set(editableFields(v.item.fields)), error: () => this.fields.set([]) });
    }
  }

  pickField(name: string): void {
    this.fieldValue = this.fields().find((f) => f.name === name)?.value ?? '';
  }

  sendField(i: CardItem): void {
    if (this.field) this.direct(i, { field: this.field, value: this.fieldValue }, this.fieldValue ? `${this.field} is now ${this.fieldValue}.` : `${this.field} cleared.`);
  }

  /** The states the item's type has, from the connection's lists; the current one when the lists are not read yet. */
  statesOf(type: string | null): string[] {
    const all = (this.state.lists()?.states ?? []).filter((s) => !type || s.type.toLowerCase() === type.toLowerCase()).map((s) => s.name);
    return [...new Set(all)];
  }

  /** The user's own direct write (specs/028): sent at once with their token, no bundle. */
  private direct(i: CardItem, body: { state?: string; comment?: string; field?: string; value?: string }, done: string): void {
    this.busy.set(true);
    this.api.direct(i.conn, i.item, { ...body, card: this.cardId(), board: this.boardId() }).subscribe({
      next: () => { this.busy.set(false); this.comment = ''; this.say(done); this.load(this.cardId()); this.loadBundles(); },
      error: (e) => { this.busy.set(false); this.say(e?.error?.error === 'TOKEN_MISSING' ? 'Enter your token in the Team tab first' : e?.error?.message || 'Not sent', true); },
    });
  }

  sendComment(i: CardItem): void {
    if (this.comment.trim()) this.direct(i, { comment: this.comment.trim() }, `Comment sent to ${i.type} ${i.item}.`);
  }

  sendState(i: CardItem): void {
    if (this.newState && this.newState !== i.state) this.direct(i, { state: this.newState }, `${i.type} ${i.item} is now ${this.newState}.`);
  }

  /** "Draft with Claude": asks the board's chat to prepare the update as a bundle on this card. */
  draftWithClaude(): void {
    const board = this.boardId();
    if (!board || this.project() === null) return;
    this.busy.set(true);
    this.chatApi.post(this.project()!, board, { text: `/alfred-team update card #${this.cardNumber()}` }).subscribe({
      next: () => { this.busy.set(false); this.panel.set(null); this.say('Asked in the board chat - the draft comes back here as a bundle to approve.'); },
      error: (e) => { this.busy.set(false); this.say(e?.error?.message || 'Not sent', true); },
    });
  }

  loadBundles(): void {
    const id = this.cardId();
    this.api.bundles({ card: id }).subscribe({ next: (b) => this.cardId() === id && this.bundles.set(b), error: () => this.bundles.set([]) });
  }

  private say(m: string, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  plain(s: string): string {
    return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  }

  toggleComments(i: CardItem): void {
    const k = i.conn + i.item;
    this.showComments.set(this.showComments() === k ? null : k);
  }

  private conn(): string | null {
    return this.items()[0]?.conn ?? this.state.picked()?.id ?? null;
  }

  link(): void {
    const conn = this.conn();
    const ref = this.ref.trim();
    if (!conn || !ref) return;
    const item = (/\/_workitems\/edit\/(\d+)/.exec(ref)?.[1]) ?? ref.replace(/^AB#/i, '');
    this.api.linkCard(this.cardId(), conn, item, this.markers).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.linked.emit(r.items);
        this.ref = '';
        this.mode.set(null);
        if (r.bundle) {
          this.loadBundles();
          this.say(`Linked. Telling ${this.state.ui().label} waits for your approval below.`);
        }
      },
      error: (e) => this.say(e?.error?.message || 'Could not link it', true),
    });
  }

  openCreate(): void {
    this.type = this.type || this.types().find((t) => /bug/i.test(t)) || this.types()[0] || '';
    this.title = this.cardTitle();
    this.description = this.cardDescription();
    this.mode.set('create');
  }

  create(): void {
    const conn = this.conn();
    if (!conn) return;
    this.busy.set(true);
    this.api.createFromCard(this.cardId(), { conn, type: this.type, title: this.title.trim(), description: this.description, area: this.area || undefined,
      iteration: this.iteration || undefined, markers: this.markers }).subscribe({
      next: () => {
        this.busy.set(false);
        this.mode.set(null);
        this.loadBundles();
        this.say('Ready to create - approve it below. Nothing is written before you do.');
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not create it', true);
      },
    });
  }

  unlink(i: CardItem): void {
    this.api.unlinkCard(this.cardId(), i.conn, i.item).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.linked.emit(r.items);
        if (r.bundle) {
          this.loadBundles();
          this.say(`Unlinked. Cleaning up in ${this.state.ui().label} waits for your approval below.`);
        }
      },
      error: (e) => this.say(e?.error?.message || 'Could not unlink it', true),
    });
  }
}
