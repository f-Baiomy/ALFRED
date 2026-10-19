import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import { LinksStateService } from '../../../core/links/links-state.service';
import { originOf, splitRef } from '../../../core/links/remote-ref';

/**
 * Where a cycle, board or call comes from (D24): `⇇ 83` with its link's state, and the details on click - who streams
 * it, how (view or comment, passed on), the link's health, and what the host may do with it. "local" for this Alfred's
 * own things, a copy chip for one kept with "Keep a copy" (D34). Offline and "stream ended" are states, never errors.
 */
@Component({
  selector: 'app-origin-pill',
  standalone: true,
  imports: [RouterLink, CloseOnOutsideDirective],
  template: `
    @if (copyOf()) {
      <span class="op-chip op-copy" title="A copy kept here - not live">copy · from {{ copyOf() }}</span>
    } @else if (!slug()) {
      @if (showLocal()) { <span class="op-chip op-local">local</span> }
    } @else {
      <span class="op-wrap" [appCloseOnOutside]="open()" (closed)="open.set(false)">
        <button type="button" class="op-chip op-remote" [class.off]="!online()" [class.ended]="ended()" (click)="toggle($event)"
          [attr.aria-expanded]="open()" [title]="title()">
          <span class="op-dot" aria-hidden="true"></span>⇇ {{ name() }}@if (ended()) { <span class="op-state">· ended</span> } @else if (!online()) { <span class="op-state">· offline</span> }
        </button>
        @if (open()) {
          <div class="op-pop" role="dialog" [attr.aria-label]="'From ' + name()">
            <div class="op-row"><b>From {{ name() }}</b>@if (link()?.peerName && link()?.peerName !== name()) { <span class="op-dim"> - it calls itself {{ link()?.peerName }}</span> }</div>
            @if (link()?.address) { <div class="op-row op-dim">{{ link()?.address }} · Alfred {{ link()?.peerVersion || '?' }}</div> }
            <div class="op-row">
              @if (online()) { <span class="op-ok">● online</span>@if (link()?.rttMs !== null && link()?.rttMs !== undefined) { <span class="op-dim"> · {{ link()?.rttMs }} ms</span> } }
              @else { <span class="op-bad">● offline</span><span class="op-dim"> - {{ link()?.lastError || 'not connected' }}</span> }
            </div>
            @if (link()?.skewed) { <div class="op-row op-warn">Its clock is {{ skew() }} off this one's - re-test windows may be off</div> }
            @if (stream(); as s) {
              <div class="op-row">{{ s.kind === 'BOARD' ? 'Board' : 'Cycle' }} stream · <b>{{ s.mode === 'COMMENT' ? 'view + comment' : 'view only' }}</b>
                @if (s.env) { <span class="op-env">🧪 {{ s.env }}</span> }</div>
              @if (s.endedAt) { <div class="op-row op-warn">{{ name() }} stopped streaming this</div> }
              @if (via()) { <div class="op-row op-dim">Passed on through {{ via() }}</div> }
            } @else if (via()) {
              <div class="op-row op-dim">Passed on through {{ via() }} - its owner allows it</div>
            }
            <div class="op-row op-dim">Read live from {{ name() }} - nothing of it is kept here.</div>
            <div class="op-acts">
              @if (canCopy()) { <button type="button" class="op-btn" (click)="keepCopy.emit(); open.set(false)" title="Import it here in full - a copy, never live again">⧉ Keep a copy</button> }
              @if (canRemove()) { <button type="button" class="op-btn" (click)="remove.emit(); open.set(false)">Remove from this board</button> }
              <a class="op-btn" routerLink="/settings" [queryParams]="{ section: 'links' }" (click)="open.set(false)">Link settings</a>
            </div>
          </div>
        }
      </span>
    }`,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .op-wrap { position: relative; display: inline-flex; }
    .op-chip { display: inline-flex; align-items: center; gap: .3rem; font-size: .72rem; line-height: 1; padding: .22rem .5rem; border-radius: 99px;
      border: 1px solid var(--border); background: var(--card); color: var(--text-dim); white-space: nowrap; font-family: inherit; }
    button.op-chip { cursor: pointer; }
    .op-remote { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 45%, transparent); }
    .op-remote.off { color: var(--text-dim); border-style: dashed; }
    .op-remote.ended { color: var(--text-faint); text-decoration: line-through; }
    .op-copy { color: var(--purple-light); }
    .op-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
    .off .op-dot, .ended .op-dot { background: var(--text-faint); }
    .op-state { color: var(--text-faint); }
    .op-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 280px; max-width: 360px; padding: .7rem .8rem; border-radius: 10px;
      background: var(--popover-solid); border: 1px solid var(--border-strong); box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: .8rem; color: var(--text); }
    .op-row { margin: .2rem 0; line-height: 1.35; }
    .op-dim { color: var(--text-dim); }
    .op-ok { color: var(--green); }
    .op-bad { color: var(--red); }
    .op-warn { color: var(--amber); }
    .op-env { margin-left: .35rem; color: var(--amber); }
    .op-acts { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .55rem; }
    .op-btn { font: inherit; font-size: .75rem; padding: .3rem .55rem; border-radius: 6px; border: 1px solid var(--border); background: var(--card);
      color: var(--text); cursor: pointer; text-decoration: none; }
    .op-btn:hover { border-color: var(--border-strong); }
  `],
})
export class OriginPillComponent {
  private readonly links = inject(LinksStateService);

  /** A ref (`<id>@<slug>`) or a bare slug. */
  readonly ref = input<string | null | undefined>(null);
  readonly kind = input<'CYCLE' | 'BOARD' | 'CALL'>('CYCLE');
  /** "copy · from 83" instead of a live pill (a kept copy, D34). */
  readonly copyOf = input<string | null>(null);
  readonly showLocal = input(false);
  /** This Alfred is the board's host (D34: only the host keeps a copy; D25: only the host removes it). */
  readonly host = input(false);
  readonly allowCopy = input(false);
  readonly allowRemove = input(false);

  readonly keepCopy = output<void>();
  readonly remove = output<void>();

  readonly open = signal(false);

  readonly slug = computed(() => {
    const r = this.ref();
    if (!r) return null;
    if (/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(r) && this.links.slugs().has(r)) return r;
    return originOf(r, this.links.slugs());
  });
  readonly link = computed(() => this.links.linkOf(this.slug()));
  readonly name = computed(() => this.links.nameOf(this.slug()));
  readonly online = computed(() => !!this.link()?.online);
  /** A ref read through two links: the inner Alfred is the owner, this link passes it on (D8). */
  readonly via = computed(() => {
    const s = splitRef(this.ref());
    const inner = s ? splitRef(s.inner) : null;
    return inner ? this.name() : null;
  });
  readonly stream = computed(() => {
    const l = this.link();
    const s = splitRef(this.ref());
    if (!l || !s || this.kind() === 'CALL') return undefined;
    return this.links.givenStream(l.id, this.kind() === 'BOARD' ? 'BOARD' : 'CYCLE', s.inner);
  });
  readonly ended = computed(() => !!this.stream()?.endedAt);
  readonly canCopy = computed(() => this.allowCopy() && this.host() && this.kind() === 'CYCLE' && this.online() && !this.ended() && !this.via());
  readonly canRemove = computed(() => this.allowRemove() && this.host());
  readonly title = computed(() => `${this.kind() === 'BOARD' ? 'Board' : this.kind() === 'CALL' ? 'Call' : 'Cycle'} streamed from ${this.name()}`
    + (this.online() ? '' : ' (offline)'));
  readonly skew = computed(() => {
    const ms = Math.abs(this.link()?.clockOffsetMs ?? 0);
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
  });

  toggle(event: Event): void {
    event.stopPropagation();
    this.open.update((v) => !v);
  }
}
