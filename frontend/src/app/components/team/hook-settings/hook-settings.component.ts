import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { HookInfo, TypeKind } from '../../../core/team/team.models';

const KINDS: TypeKind['kind'][] = ['BUG', 'TASK', 'QUESTION', 'NOTE', 'NONE'];

/**
 * A connection's service hook and type → card kind map (specs/028 US5 FR-070..074, FR-054): the URL to paste into the
 * tracker's service hook, the secret (shown once when made), Alfred's public address for the "via Alfred" links, the last
 * ping, and which card kind each work item type becomes in Incoming.
 */
@Component({
  selector: 'app-team-hook-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="ths">
      @if (hook(); as h) {
        <div class="ths-row"><b>Hook URL</b> <code>{{ url(h) }}</code>
          <button type="button" class="action-btn" (click)="copy(url(h))">Copy</button></div>
        <div class="ths-row"><b>Secret</b>
          @if (secret()) { <code>{{ secret() }}</code> <span class="ths-warn">shown once - paste it as the hook's basic-auth password now</span> }
          @else { <span class="ths-dim">{{ h.secretSet ? 'set' : 'not set - the hook refuses every ping until one is made' }}</span> }
          <button type="button" class="action-btn" (click)="rotate()">{{ h.secretSet ? 'Make a new secret' : 'Make the secret' }}</button></div>
        <form class="ths-row" (submit)="$event.preventDefault(); savePublic()">
          <b>Public address</b>
          <input [(ngModel)]="publicAddress" name="pub" placeholder="https://alfred.example.com (for the links in the tracker)" />
          <button type="submit" class="action-btn">Save</button>
        </form>
        <div class="ths-row ths-dim">Last ping: {{ h.lastPingAt ? h.lastPingAt.slice(0, 16).replace('T', ' ') + ' · ' + (h.lastEvent || '') : 'never' }}
          @if (h.badPings) { · <span class="ths-warn">{{ h.badPings }} refused</span> }
          @if (h.waiting.length) { · {{ h.waiting.length }} item(s) wait for a token: {{ h.waiting.join(', ') }} }</div>
      } @else { <div class="ths-dim">{{ error() || 'Reading…' }}</div> }

      <h5>Work item type → card kind (Incoming → New card)</h5>
      <div class="ths-kinds">
        @for (t of types(); track t) {
          <label>{{ t }}
            <select [ngModel]="kindOf(t)" (ngModelChange)="putKind(t, $event)" [name]="'k-' + t">
              @for (k of KINDS; track k) { <option [value]="k">{{ k === 'NONE' ? 'no card (refused)' : k.toLowerCase() }}</option> }
            </select>
          </label>
        } @empty { <span class="ths-dim">The types come with the lists - Refresh lists on the Team tab.</span> }
      </div>
      @if (message()) { <div class="ths-msg" [class.err]="isError()">{{ message() }}</div> }
    </div>`,
  styles: [`
    .ths { display: grid; gap: .4rem; padding: .5rem; border: 1px solid var(--border); border-radius: 8px; font-size: .82rem; }
    .ths-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .ths-row input { flex: 1 1 260px; padding: .25rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    code { word-break: break-all; }
    .ths-dim { color: var(--text-dim); }
    .ths-warn { color: var(--amber); }
    h5 { margin: .4rem 0 0; }
    .ths-kinds { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: .4rem; }
    .ths-kinds label { display: grid; gap: .15rem; color: var(--text-dim); font-size: .76rem; }
    .ths-kinds select { padding: .2rem .4rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: var(--text); }
    .ths-msg { color: var(--green); }
    .ths-msg.err { color: var(--red); }
  `],
})
export class TeamHookSettingsComponent {
  private readonly api = inject(TeamApiService);
  private readonly state = inject(TeamStateService);
  readonly KINDS = KINDS;

  readonly conn = input.required<string>();
  readonly hook = signal<HookInfo | null>(null);
  readonly kinds = signal<TypeKind[]>([]);
  readonly secret = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);
  publicAddress = '';

  readonly types = computed(() => {
    const listed = this.state.picked()?.id === this.conn() ? this.state.lists()?.types ?? [] : [];
    return [...new Set([...listed, ...this.kinds().map((k) => k.type)])].sort();
  });

  constructor() {
    effect(() => {
      const c = this.conn();
      this.state.hookVersion();
      untracked(() => this.load(c));
    });
  }

  private load(c: string): void {
    this.api.hook(c).subscribe({
      next: (h) => {
        this.hook.set(h);
        this.publicAddress = h.publicAddress ?? '';
      },
      error: (e) => this.error.set(e?.error?.message || 'Could not read the hook'),
    });
    this.api.typeKinds(c).subscribe({ next: (k) => this.kinds.set(k), error: () => undefined });
  }

  url(h: HookInfo): string {
    const base = (h.publicAddress || window.location.origin).replace(/\/$/, '');
    return base + h.path;
  }

  kindOf(type: string): string {
    return this.kinds().find((k) => k.type === type)?.kind ?? (/bug/i.test(type) ? 'BUG' : /feature|epic/i.test(type) ? 'NONE' : 'TASK');
  }

  putKind(type: string, kind: string): void {
    this.api.putTypeKind(this.conn(), type, kind).subscribe({
      next: (k) => this.kinds.update((all) => [...all.filter((x) => x.type !== k.type), k]),
      error: (e) => this.say(e?.error?.message || 'Could not save it', true),
    });
  }

  rotate(): void {
    this.api.rotateHookSecret(this.conn()).subscribe({
      next: (r) => {
        this.secret.set(r.secret);
        this.load(this.conn());
      },
      error: (e) => this.say(e?.error?.message || 'Could not make a secret - Settings may be read-only from here', true),
    });
  }

  savePublic(): void {
    this.api.putHook(this.conn(), this.publicAddress.trim() || null).subscribe({
      next: (h) => {
        this.hook.set(h);
        this.say('Saved', false);
      },
      error: (e) => this.say(e?.error?.message || 'Could not save it', true),
    });
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => this.say('Copied', false), () => this.say(text, false));
  }

  private say(m: string, err: boolean): void {
    this.message.set(m);
    this.isError.set(err);
  }
}
