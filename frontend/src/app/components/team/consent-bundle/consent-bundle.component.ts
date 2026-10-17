import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AzureEvidenceService } from '../../../core/team/azure-evidence.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { StepKind, WriteBundle, WriteStep } from '../../../core/team/team.models';

const WORDS: Record<StepKind, string> = {
  STATE: 'Move to', COMMENT: 'Comment', ATTACH: 'Attach', HYPERLINK: 'Link back to Alfred', UNHYPERLINK: 'Remove the link to Alfred',
  TAG: 'Tag', UNTAG: 'Remove the tag', CREATE: 'Create', LINK_ALFRED: 'Link in Alfred',
};

/**
 * One consent bundle (specs/028 US4 FR-075..084): every write to the tracker Claude or Alfred prepared, step by step, each
 * tickable and editable; attachments built here from Alfred's own export with secrets masked (or sent unmasked when
 * ticked). Nothing is sent before Approve, and only the user approves.
 */
@Component({
  selector: 'app-team-consent-bundle',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (b(); as w) {
      <div class="tcb" [class]="'tcb tcb-' + w.state">
        <div class="tcb-head">
          <b>{{ w.title }}</b>
          <span class="tcb-dim">{{ origin(w) }} · {{ w.item ? 'item ' + w.item : 'new item' }} · {{ w.state.toLowerCase() }}</span>
        </div>
        @for (s of steps(); track $index; let i = $index) {
          <div class="tcb-step">
            <label class="tcb-tick"><input type="checkbox" [checked]="s.ticked" [disabled]="!open()" (change)="tick(i, $any($event.target).checked)" />
              <b>{{ word(s.kind) }}</b></label>
            @switch (s.kind) {
              @case ('COMMENT') {
                @if (open()) { <textarea rows="3" [ngModel]="s.payload['text']" (ngModelChange)="edit(i, 'text', $event)" [name]="'t' + i"></textarea> }
                @else { <span class="tcb-text">{{ s.payload['text'] }}</span> }
              }
              @case ('STATE') {
                @if (open()) { <input [ngModel]="s.payload['state']" (ngModelChange)="edit(i, 'state', $event)" [name]="'s' + i" /> }
                @else { <span>{{ s.payload['state'] }}</span> }
              }
              @case ('ATTACH') {
                <span>{{ s.payload['name'] }}</span>
                @if (open()) {
                  <label class="tcb-tick" title="Masks nothing - not even Authorization or cookies"><input type="checkbox" [checked]="s.unmasked"
                         (change)="unmask(i, $any($event.target).checked)" /> send unmasked</label>
                  <button type="button" class="action-btn" [disabled]="building() === i" (click)="build(i)">{{ building() === i ? 'Building…' : built()[i] ? 'Rebuild' : 'Build the file' }}</button>
                  @if (built()[i]) { <span class="tcb-dim">{{ built()[i] }}</span> }
                }
              }
              @case ('CREATE') { <span>{{ s.payload['type'] }}: {{ s.payload['title'] }}</span> }
              @default { <span class="tcb-dim">{{ payloadText(s) }}</span> }
            }
            @if (s.result; as r) { <span class="tcb-res" [class.err]="!r.ok">{{ r.ok ? '✓ sent' : '✗ ' + (r.message || 'failed') }}</span> }
          </div>
        }
        @if (open() && editable()) {
          <div class="tcb-acts">
            <button type="button" class="action-btn primary" [disabled]="busy() || !ticked()" (click)="approve()">Approve {{ ticked() }} step{{ ticked() === 1 ? '' : 's' }}</button>
            <button type="button" class="action-btn" [disabled]="busy()" (click)="reject()">Reject</button>
            @if (dirty()) { <button type="button" class="action-btn" [disabled]="busy()" (click)="save()">Save changes</button> }
            @if (!state.hasToken()) { <span class="tcb-dim">Needs a live token to send - enter it on the Team tab.</span> }
          </div>
        }
        @if (message()) { <div class="tcb-msg" [class.err]="isError()">{{ message() }}</div> }
      </div>
    }`,
  styles: [`
    .tcb { display: grid; gap: .35rem; padding: .5rem .6rem; border: 1px solid var(--purple-light); border-radius: 8px; font-size: .82rem; }
    .tcb-DONE, .tcb-REJECTED { border-color: var(--border); opacity: .8; }
    .tcb-PARTIAL { border-color: var(--amber); }
    .tcb-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; }
    .tcb-dim { color: var(--text-dim); font-size: .76rem; }
    .tcb-step { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .tcb-step textarea, .tcb-step input:not([type=checkbox]) { flex: 1 1 260px; padding: .25rem .4rem; border: 1px solid var(--border-strong); border-radius: 6px;
      background: var(--card-inner); color: inherit; font: inherit; }
    .tcb-tick { display: inline-flex; gap: .25rem; align-items: center; }
    .tcb-text { white-space: pre-wrap; }
    .tcb-res { font-size: .76rem; color: var(--green); }
    .tcb-res.err { color: var(--red); }
    .tcb-acts { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
    .tcb-msg { color: var(--green); font-size: .78rem; }
    .tcb-msg.err { color: var(--red); }
  `],
})
export class TeamConsentBundleComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly evidence = inject(AzureEvidenceService);

  readonly bundle = input.required<WriteBundle>();
  readonly editable = input(true);
  readonly changed = output<WriteBundle>();

  private readonly edited = signal<{ id: number; steps: WriteStep[] } | null>(null);
  readonly b = computed(() => this.bundle());
  readonly steps = computed(() => (this.edited()?.id === this.bundle().id ? this.edited()!.steps : this.bundle().steps));
  readonly dirty = computed(() => this.edited()?.id === this.bundle().id);
  readonly open = computed(() => this.bundle().state === 'WAITING');
  readonly ticked = computed(() => this.steps().filter((s) => s.ticked).length);
  readonly busy = signal(false);
  readonly building = signal<number | null>(null);
  readonly built = signal<Record<number, string>>({});
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);

  word(k: StepKind): string {
    return WORDS[k] ?? k;
  }

  origin(w: WriteBundle): string {
    return w.origin === 'CLAUDE' ? '✦ Claude asks' : w.origin === 'ALFRED' ? 'Alfred prepared it' : 'yours';
  }

  payloadText(s: WriteStep): string {
    return Object.entries(s.payload).map(([k, v]) => `${k}: ${v}`).join(' · ');
  }

  private change(i: number, f: (s: WriteStep) => WriteStep): void {
    const steps = this.steps().map((s, j) => (j === i ? f({ ...s, payload: { ...s.payload } }) : s));
    this.edited.set({ id: this.bundle().id, steps });
  }

  tick(i: number, on: boolean): void {
    this.change(i, (s) => ({ ...s, ticked: on }));
  }

  edit(i: number, key: string, value: string): void {
    this.change(i, (s) => ({ ...s, payload: { ...s.payload, [key]: value } }));
  }

  unmask(i: number, on: boolean): void {
    this.change(i, (s) => ({ ...s, unmasked: on }));
    this.built.update((b) => ({ ...b, [i]: '' }));
  }

  private say(m: string, err = false): void {
    this.message.set(m);
    this.isError.set(err);
  }

  save(then?: () => void): void {
    const e = this.edited();
    if (!e) {
      then?.();
      return;
    }
    this.busy.set(true);
    this.api.editBundle(e.id, { steps: e.steps }).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.edited.set(null);
        this.changed.emit(w);
        then?.();
      },
      error: (err) => {
        this.busy.set(false);
        this.say(err?.error?.message || 'Could not save the changes', true);
      },
    });
  }

  async build(i: number): Promise<void> {
    const s = this.steps()[i];
    const card = this.bundle().cardId;
    if (!card) return this.say('This bundle is on no card: there are no calls to build the file from', true);
    if (s.payload['card'] && s.payload['card'] !== card) return this.say('This attachment names another card - reject the bundle', true);
    this.building.set(i);
    try {
      const r = await this.evidence.build(card, s.unmasked);
      this.save(() => this.api.bundleFile(this.bundle().id, i, s.payload['name'] || 'evidence.html', r.blob).subscribe({
        next: (w) => {
          this.building.set(null);
          this.built.update((b) => ({ ...b, [i]: `${r.calls} call(s), ${Math.round(r.blob.size / 1024)} KB${s.unmasked ? ', unmasked' : ', masked'}`
            + (r.missing ? ` · ${r.missing} call(s) no longer readable` : '') }));
          this.changed.emit(w);
        },
        error: (e) => {
          this.building.set(null);
          this.say(e?.error?.message || 'Could not upload the file', true);
        },
      }));
    } catch {
      this.building.set(null);
      this.say('Could not build the file', true);
    }
  }

  approve(): void {
    this.save(() => {
      this.busy.set(true);
      this.api.approve(this.bundle().id).subscribe({
        next: (w) => {
          this.busy.set(false);
          this.changed.emit(w);
          this.say(w.state === 'DONE' ? 'Sent' : w.state === 'PARTIAL' ? 'Some steps failed - see each step' : w.state.toLowerCase(), w.state === 'PARTIAL');
        },
        error: (e) => {
          this.busy.set(false);
          this.say(e?.error?.message || 'Could not send', true);
        },
      });
    });
  }

  reject(): void {
    this.busy.set(true);
    this.api.reject(this.bundle().id).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.edited.set(null);
        this.changed.emit(w);
      },
      error: (e) => {
        this.busy.set(false);
        this.say(e?.error?.message || 'Could not reject it', true);
      },
    });
  }
}
