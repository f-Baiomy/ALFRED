import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LinksApiService } from '../../../core/links/links-api.service';
import { LinksStateService, problemOf } from '../../../core/links/links-state.service';
import { Stream, StreamMode } from '../../../core/links/links.models';
import { StreamDialogService } from './stream-dialog.service';

interface Draft {
  linkId: string | null;
  mode: StreamMode;
  autoAccept: boolean;
  passOn: boolean;
  passMode: StreamMode;
  unmasked: boolean;
}

const EMPTY: Draft = { linkId: null, mode: 'VIEW', autoAccept: false, passOn: false, passMode: 'VIEW', unmasked: false };

/**
 * Stream a cycle or a board to a linked Alfred, or change / stop a stream (D5-D8, D12, D17). One per app, opened through
 * {@link StreamDialogService}. Picking a link that already has this thing streamed edits that stream.
 */
@Component({
  selector: 'app-stream-dialog',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (svc.target(); as t) {
      <div class="dialog-backdrop" (click)="close()">
        <div class="dialog-card lk-dialog" role="dialog" aria-modal="true" [attr.aria-label]="'Stream ' + t.name" (click)="$event.stopPropagation()"
             (keydown.escape)="close()">
          <h2>{{ existing() ? 'Change stream' : 'Stream' }} {{ t.kind === 'BOARD' ? 'board' : 'cycle' }} <span class="lk-dim">"{{ t.name }}"</span></h2>

          <div class="lk-field">
            <div class="lk-fl">To</div>
            @if (links.links().length) {
              <span class="lk-seg">
                @for (l of links.links(); track l.id) {
                  <button type="button" [class.on]="draft().linkId === l.id" (click)="pickLink(l.id)">
                    {{ l.name }}@if (!l.online) { <span class="lk-dim"> (offline)</span> }
                    @if (streamTo(l.id)) { <span class="lk-ok" title="Already streamed to it"> ●</span> }
                  </button>
                }
              </span>
            } @else {
              <span class="lk-warn">Link an Alfred first - <a routerLink="/settings" [queryParams]="{ section: 'links' }" (click)="close()">Settings → Links &amp; streams</a>.</span>
            }
          </div>

          <div class="lk-field">
            <div class="lk-fl">What it carries</div>
            @if (t.kind === 'BOARD') {
              <div class="lk-small">Cards and their activity, the brief, spec files, requirements, test steps, pages and pictures, the Azure copies
                (read-only), the board chat (read-only), and its cycles - this Alfred's own in full; another Alfred's only where its owner
                allows passing on.</div>
            } @else {
              <div class="lk-small">Every call of the cycle - also those recorded after now - with headers, bodies, SQL, log lines and Redis
                commands, its spacers and comments.</div>
            }
          </div>

          <div class="lk-field">
            <div class="lk-fl">What they may do</div>
            <span class="lk-seg">
              <button type="button" [class.on]="draft().mode === 'VIEW'" (click)="patch({ mode: 'VIEW' })">View</button>
              <button type="button" [class.on]="draft().mode === 'COMMENT'" (click)="patch({ mode: 'COMMENT' })">Comment</button>
            </span>
            <div class="lk-note">
              @if (draft().mode === 'VIEW') { Read everything streamed, nothing else. }
              @else { View, plus comments and questions on cards, comments on the brief and notes on calls - each a request you accept or reject. }
              Cards, states, the brief, specs, recording and the chat stay yours alone.
            </div>
          </div>

          @if (draft().mode === 'COMMENT') {
            <div class="lk-field">
              <div class="lk-fl">Accept their requests automatically</div>
              <span class="lk-seg">
                <button type="button" [class.on]="!draft().autoAccept" (click)="patch({ autoAccept: false })">Off</button>
                <button type="button" [class.on]="draft().autoAccept" (click)="patch({ autoAccept: true })">On</button>
              </span>
              <div class="lk-note">{{ draft().autoAccept ? 'Every request goes in at once.' : 'Every request shows you a popup.' }}
                Auto-accepted requests are recorded and can be undone.</div>
            </div>
          }

          @if (t.kind === 'CYCLE') {
            <div class="lk-field">
              <label class="lk-check"><input type="checkbox" [checked]="draft().passOn" (change)="patch({ passOn: $any($event.target).checked })" /> Allow passing on</label>
              <div class="lk-note">They may carry it inside their own board streams to a third Alfred, which may:
                <span class="lk-seg lk-seg-sm" [class.off]="!draft().passOn">
                  <button type="button" [disabled]="!draft().passOn" [class.on]="draft().passMode === 'VIEW'" (click)="patch({ passMode: 'VIEW' })">View</button>
                  <button type="button" [disabled]="!draft().passOn" [class.on]="draft().passMode === 'COMMENT'" (click)="patch({ passMode: 'COMMENT' })">Comment</button>
                </span>
              </div>
            </div>
          }

          <div class="lk-field">
            <label class="lk-check"><input type="checkbox" [checked]="draft().unmasked" (change)="patch({ unmasked: $any($event.target).checked })" /> Send unmasked</label>
            <div class="lk-note">
              @if (draft().unmasked) { <span class="lk-warn">They will see real Authorization headers, cookies, API keys and unredacted bodies.</span> }
              @else { Authorization, cookies, API keys and everything your redaction rules match (bodies too) are masked here, before anything leaves. }
            </div>
          </div>

          <div class="lk-note">Never through a stream: Azure and the team tracker, settings, recording, the ▤ ◆ ⬢ switches, interception rules, exports,
            Relive, your Claude or your chat input.</div>

          @if (error()) { <div class="dialog-error-note" role="alert">{{ error() }}</div> }

          <div class="dialog-actions">
            @if (existing(); as s) { <button type="button" class="dialog-btn danger" [disabled]="busy()" (click)="stop(s)">Stop stream</button> }
            <span class="lk-sp"></span>
            <button type="button" class="dialog-btn secondary" (click)="close()">Cancel</button>
            <button type="button" class="dialog-btn primary" [disabled]="!draft().linkId || busy()" (click)="save()">{{ existing() ? 'Save' : 'Start stream' }}</button>
          </div>
        </div>
      </div>
    }`,
})
export class StreamDialogComponent {
  readonly svc = inject(StreamDialogService);
  readonly links = inject(LinksStateService);
  private readonly api = inject(LinksApiService);

  readonly draft = signal<Draft>(EMPTY);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** The active stream of this target to the picked link: the dialog edits it instead of starting a second. */
  readonly existing = computed(() => {
    const t = this.svc.target();
    const id = this.draft().linkId;
    return t && id ? this.streamTo(id) : undefined;
  });

  constructor() {
    // re-picked when the dialog opens (and once the links have loaded) - never while the user edits it, whatever the
    // socket refreshes meanwhile
    effect(() => {
      const t = this.svc.target();
      const loaded = this.links.loaded();
      if (!t) return;
      untracked(() => {
        this.links.start();
        this.error.set(null);
        if (!loaded) return;
        // a target streamed to exactly one link opens on that stream; otherwise the only link, else nothing picked
        const current = this.links.streamsOf(t.kind, t.target);
        const only = this.links.links().length === 1 ? this.links.links()[0].id : null;
        this.pickLink(current.length === 1 ? current[0].linkId : only);
      });
    }, { allowSignalWrites: true });
  }

  streamTo(linkId: string): Stream | undefined {
    const t = this.svc.target();
    return t ? this.links.streamsOf(t.kind, t.target).find((s) => s.linkId === linkId) : undefined;
  }

  pickLink(linkId: string | null): void {
    const s = linkId ? this.streamTo(linkId) : undefined;
    this.draft.set(s
      ? { linkId, mode: s.mode, autoAccept: s.autoAccept, passOn: s.passOn, passMode: s.passMode, unmasked: s.unmasked }
      : { ...EMPTY, linkId });
  }

  patch(p: Partial<Draft>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  close(): void {
    this.svc.close();
  }

  save(): void {
    const t = this.svc.target();
    const d = this.draft();
    if (!t || !d.linkId) return;
    this.busy.set(true);
    this.error.set(null);
    const s = this.existing();
    const passOn = t.kind === 'CYCLE' && d.passOn;
    const done = {
      next: () => {
        this.busy.set(false);
        this.links.reload();
        this.close();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(problemOf(e).message);
      },
    };
    if (s) {
      this.api.updateStream(s.id, { mode: d.mode, autoAccept: d.mode === 'COMMENT' && d.autoAccept, passOn, passMode: d.passMode, unmasked: d.unmasked })
        .subscribe(done);
    } else {
      this.api.startStream({ linkId: d.linkId, kind: t.kind, target: t.target, targetName: t.name, project: t.project, mode: d.mode,
        autoAccept: d.mode === 'COMMENT' && d.autoAccept, passOn, passMode: d.passMode, unmasked: d.unmasked }).subscribe(done);
    }
  }

  stop(s: Stream): void {
    this.busy.set(true);
    this.api.stopStream(s.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.links.reload();
        this.close();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(problemOf(e).message);
      },
    });
  }
}
