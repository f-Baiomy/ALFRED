import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';
import { LinksApiService } from '../../../core/links/links-api.service';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { Stream, StreamKind } from '../../../core/links/links.models';
import { StreamDialogService } from '../stream-dialog/stream-dialog.service';

/**
 * This Alfred's own cycle or board, streamed out (D24): `⇉ 83 · comment ▾` - one reader, or `⇉ 2 Alfreds ▾`. The
 * details list each reader with what it may do, auto-accept, passing on, secrets, since, who has it open now and the
 * requests waiting, with Change and Stop. Nothing renders while it is streamed to nobody.
 */
@Component({
  selector: 'app-out-pill',
  standalone: true,
  imports: [DatePipe, CloseOnOutsideDirective],
  template: `
    @if (streams().length) {
      <span class="op-wrap" [appCloseOnOutside]="open()" (closed)="open.set(false)">
        <button type="button" class="lk-chip cyan op-out" (click)="open.set(!open()); $event.stopPropagation()" [attr.aria-expanded]="open()"
                [title]="'Streamed to ' + names()">
          ⇉ {{ label() }} ▾@if (waiting()) { <span class="op-wait" title="Requests waiting for you">⇄{{ waiting() }}</span> }
        </button>
        @if (open()) {
          <div class="op-pop" role="dialog" aria-label="Streamed to">
            @for (s of streams(); track s.id) {
              <div class="op-reader">
                <div><b>{{ nameOf(s) }}</b>
                  @if (online(s)) { <span class="lk-ok"> ● online</span> } @else { <span class="lk-dim"> offline</span> }
                  @if (viewers(s)) { <span class="lk-dim"> · 👁 open now</span> }</div>
                <div class="lk-small lk-dim">{{ s.mode === 'COMMENT' ? 'view + comment' : 'view only' }}
                  · auto-accept {{ s.mode === 'COMMENT' && s.autoAccept ? 'on' : 'off' }}
                  @if (kind() === 'CYCLE') { · pass on {{ s.passOn ? (s.passMode === 'COMMENT' ? 'comment' : 'view') : 'no' }} }
                  · @if (s.unmasked) { <span class="lk-warn">unmasked</span> } @else { masked } · since {{ s.createdAt | date: 'd MMM HH:mm' }}</div>
                @if (waitingOf(s)) { <div class="lk-small lk-warn">{{ waitingOf(s) }} request(s) waiting for you</div> }
                <div class="lk-row">
                  <button type="button" class="lk-btn" (click)="change()">Change</button>
                  <button type="button" class="lk-btn r" [disabled]="busy()" (click)="stop(s)">Stop</button>
                </div>
              </div>
            }
            <div class="lk-row"><button type="button" class="lk-btn p" (click)="change()">＋ Stream to another…</button></div>
            @if (error()) { <div class="lk-small lk-warn">{{ error() }}</div> }
          </div>
        }
      </span>
    }`,
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .op-wrap { position: relative; display: inline-flex; }
    .op-out { cursor: pointer; font-family: inherit; background: var(--card); }
    .op-wait { margin-left: .3rem; color: var(--amber); font-weight: 700; }
    .op-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 300px; max-width: 380px; padding: .6rem .75rem; border-radius: 10px;
      background: var(--popover-solid); border: 1px solid var(--border-strong); box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: .8rem; color: var(--text); }
    .op-reader { padding: .35rem 0; border-bottom: 1px solid var(--border); }
  `],
})
export class OutPillComponent {
  private readonly links = inject(LinksStateService);
  private readonly api = inject(LinksApiService);
  private readonly dialog = inject(StreamDialogService);

  readonly kind = input.required<StreamKind>();
  readonly target = input.required<string>();
  readonly name = input('');
  readonly project = input<string | null>(null);

  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly streams = computed(() => this.links.streamsOf(this.kind(), this.target()));
  readonly names = computed(() => this.streams().map((s) => this.nameOf(s)).join(', '));
  readonly label = computed(() => {
    const list = this.streams();
    if (list.length === 1) return `${this.nameOf(list[0])} · ${list[0].mode === 'COMMENT' ? 'comment' : 'view'}`;
    return `${list.length} Alfreds`;
  });
  readonly waiting = computed(() => this.streams().reduce((n, s) => n + this.waitingOf(s), 0));

  constructor() {
    this.links.start();
  }

  nameOf(s: Stream): string {
    return this.links.linkById().get(s.linkId)?.name ?? '?';
  }

  online(s: Stream): boolean {
    return !!this.links.linkById().get(s.linkId)?.online;
  }

  viewers(s: Stream): number {
    return this.links.presence().filter((p) => p.linkId === s.linkId && p.target === s.target).reduce((n, p) => n + p.viewers, 0);
  }

  waitingOf(s: Stream): number {
    return this.links.waiting().filter((r) => r.streamId === s.id).length;
  }

  change(): void {
    this.open.set(false);
    this.dialog.open({ kind: this.kind(), target: this.target(), name: this.name() || this.target(), project: this.project() });
  }

  stop(s: Stream): void {
    this.busy.set(true);
    this.api.stopStream(s.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.links.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(problemOf(e).message);
      },
    });
  }
}
