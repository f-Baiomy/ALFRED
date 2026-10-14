import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { GlobalVariablesService } from '../../../core/services/global-variables.service';
import { copyToClipboard } from '../../../shared/utils/clipboard';

/**
 * A `{{name}}` in a board text (docs/board.md "Rich text"): the global variable's value in the active environment - the
 * text stores the name only, so switching UAT to Staging changes what every card shows. A secret shows masked and is
 * never copied; a name that does not exist shows amber with "create it". Click: every environment's value, copy, create.
 */
@Component({
  selector: 'app-variable-pill',
  standalone: true,
  template: `
    <span class="board-var" [class.unknown]="unknown()" [class.secret]="secret()" role="button" tabindex="0" [title]="title()"
          (click)="toggle($event)" (keydown.enter)="toggle($event)">{{ '{{' }}{{ name() }}{{ '}}' }}<span class="board-var-val">{{ shown() }}</span></span>
    @if (open()) {
      <span class="board-var-pop" (click)="$event.stopPropagation()">
        <span class="board-var-pop-head">{{ name() }}{{ secret() ? ' · secret' : '' }}</span>
        @for (env of envs(); track env.name) {
          <span class="board-var-env" [class.on]="env.active"><b>{{ env.name }}{{ env.active ? ' (active)' : '' }}</b>
            <span>{{ env.value === null ? (env.loading ? '…' : '-') : secret() ? '••••••' : env.value }}</span></span>
        }
        @if (unknown()) {
          <span class="board-var-create">Not a variable yet:
            <input #v class="board-var-input" placeholder="value in {{ state().activeEnvironment }}" (keydown.enter)="create(v.value)" />
            <button type="button" class="board-link" (click)="create(v.value)">create it</button></span>
        } @else if (!secret()) {
          <button type="button" class="board-link" (click)="copy()">{{ copied() ? '✓ copied' : '⧉ copy value' }}</button>
        }
      </span>
    }`,
})
export class VariablePillComponent {
  private readonly vars = inject(GlobalVariablesService);
  readonly name = input.required<string>();
  readonly open = signal(false);
  readonly copied = signal(false);
  private readonly others = signal<Readonly<Record<string, Record<string, string> | 'loading'>>>({});

  readonly state = this.vars.state;
  readonly value = computed(() => this.state().variables[this.name()]);
  readonly unknown = computed(() => this.vars.loaded() && this.value() === undefined);
  readonly secret = computed(() => this.vars.isSecret(this.name()));
  readonly shown = computed(() => (this.unknown() ? ' ?' : this.value() === undefined ? '' : ` = ${this.secret() ? '••••••' : clip(this.value()!)}`));
  readonly title = computed(() => (this.unknown() ? `${this.name()} is not a global variable - click to create it`
    : `Global variable ${this.name()} · ${this.state().activeEnvironment}${this.secret() ? ' · secret' : ''}`));
  readonly envs = computed(() => this.state().environments.map((env) => {
    const active = env === this.state().activeEnvironment;
    const other = this.others()[env];
    const value = active ? this.value() ?? null : other && other !== 'loading' ? other[this.name()] ?? null : null;
    return { name: env, active, value, loading: other === 'loading' };
  }));

  constructor() {
    this.vars.load();
    this.vars.watchForChanges();
  }

  toggle(event: Event): void {
    event.stopPropagation();
    this.open.update((o) => !o);
    if (!this.open()) return;
    for (const env of this.state().environments) {
      if (env === this.state().activeEnvironment || this.others()[env]) continue;
      this.others.update((o) => ({ ...o, [env]: 'loading' }));
      this.vars.exportEnvironment(env, (payload) => this.others.update((o) => ({ ...o, [env]: { ...payload.variables } })));
    }
  }

  copy(): void {
    const v = this.value();
    if (v === undefined || this.secret()) return;
    void copyToClipboard(v).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); });
  }

  create(value: string): void {
    this.vars.upsert(this.name(), value);
    this.open.set(false);
  }

  @HostListener('document:click')
  close(): void {
    if (this.open()) this.open.set(false);
  }
}

function clip(v: string): string {
  return v.length > 60 ? `${v.slice(0, 60)}…` : v;
}
