import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from './app-config.service';
import { VARIABLE_NAME, VARIABLE_TOKEN } from '../../shared/utils/variable-tokens';

export interface GlobalVariable { readonly name: string; readonly value: string; }
export interface GlobalVariablesState {
  readonly variables: Readonly<Record<string, string>>;
  /** Resolution policy for tokens whose variable was deleted. Missing entry means keep {{name}}. */
  readonly fallbacks: Readonly<Record<string, string>>;
}

const EMPTY: GlobalVariablesState = { variables: {}, fallbacks: {} };

@Injectable({ providedIn: 'root' })
export class GlobalVariablesService {
  private readonly http = inject(HttpClient, { optional: true });
  private readonly config = inject(AppConfigService);
  readonly state = signal<GlobalVariablesState>(EMPTY);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  private pending: GlobalVariablesState | null = null;
  private inFlight = false;
  private revision = 0;
  private readonly sortedEntries = computed(() => Object.entries(this.state().variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value })));

  load(): void {
    if (this.loaded() || this.loading()) return;
    if (!this.http) { this.loaded.set(true); return; }
    this.loading.set(true);
    const revision = this.revision;
    this.http.get<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`).subscribe({
      next: (state) => {
        if (this.revision === revision) this.state.set(this.normalize(state));
        this.loaded.set(true);
        this.loading.set(false);
        this.error.set('');
      },
      error: () => { this.loading.set(false); this.error.set('Could not load global variables.'); },
    });
  }

  entries(): GlobalVariable[] {
    return this.sortedEntries();
  }

  save(state: GlobalVariablesState): void {
    this.revision++;
    this.state.set(this.normalize(state));
    this.pending = this.state();
    this.flush();
  }

  /** Serialize full-state writes. Rapid edits must never let an old response replace a new value. */
  private flush(): void {
    if (this.inFlight || !this.pending) return;
    if (!this.http) { this.pending = null; this.saving.set(false); return; }
    const next = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.saving.set(true);
    this.http.put<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`, next).subscribe({
      next: () => {
        this.inFlight = false;
        this.error.set('');
        if (this.pending) this.flush();
        else this.saving.set(false);
      },
      error: () => {
        this.inFlight = false;
        this.pending = this.state();
        this.saving.set(false);
        this.error.set('Could not save global variables. Your edits are still here; retry before leaving.');
      },
    });
  }

  retry(): void {
    if (this.pending) this.flush();
    else if (!this.loaded()) this.load();
  }

  upsert(name: string, value: string): void {
    if (!VARIABLE_NAME.test(name) || name.startsWith('this.')) throw new Error('Invalid variable name');
    const state = this.state();
    const fallbacks = { ...state.fallbacks };
    delete fallbacks[name];
    this.save({ variables: { ...state.variables, [name]: value }, fallbacks });
  }

  remove(name: string, replacement: string | null): void {
    if (!VARIABLE_NAME.test(name) || name.startsWith('this.')) throw new Error('Invalid variable name');
    const variables = { ...this.state().variables };
    delete variables[name];
    const fallbacks = { ...this.state().fallbacks };
    if (replacement !== null) fallbacks[name] = replacement;
    else delete fallbacks[name];
    this.save({ variables, fallbacks });
  }

  /** Resolve recursively while leaving unknown tokens intact; cycles remain visible instead of hanging. */
  resolve(text: string): string {
    const state = this.state();
    const visit = (input: string, seen: ReadonlySet<string>, depth: number): string => input.replace(VARIABLE_TOKEN, (token, name: string) => {
      if (name.startsWith('this.')) return token;
      if (depth >= 20) return token;
      if (seen.has(name)) return token;
      const value = Object.prototype.hasOwnProperty.call(state.variables, name) ? state.variables[name]
        : Object.prototype.hasOwnProperty.call(state.fallbacks, name) ? state.fallbacks[name] : undefined;
      return value === undefined ? token : visit(value, new Set([...seen, name]), depth + 1);
    });
    return visit(text, new Set(), 0);
  }

  private normalize(state: GlobalVariablesState | null): GlobalVariablesState {
    return { variables: state?.variables ?? {}, fallbacks: state?.fallbacks ?? {} };
  }
}
