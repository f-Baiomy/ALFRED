import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from './app-config.service';

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

  load(): void {
    if (this.loaded() || this.loading()) return;
    if (!this.http) { this.loaded.set(true); return; }
    this.loading.set(true);
    this.http.get<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`).subscribe({
      next: (state) => { this.state.set(this.normalize(state)); this.loaded.set(true); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('Could not load global variables.'); },
    });
  }

  entries(): GlobalVariable[] {
    return Object.entries(this.state().variables).map(([name, value]) => ({ name, value }));
  }

  save(state: GlobalVariablesState): void {
    // Standalone component tests can render token-aware editors without bootstrapping the app's
    // HTTP providers. Keep their local state usable; the running Alfred app always has HttpClient.
    if (!this.http) { this.state.set(this.normalize(state)); this.saving.set(false); return; }
    this.saving.set(true);
    this.http.put<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`, state).subscribe({
      next: (saved) => { this.state.set(this.normalize(saved)); this.saving.set(false); this.error.set(''); },
      error: () => { this.saving.set(false); this.error.set('Could not save global variables.'); },
    });
  }

  upsert(name: string, value: string): void {
    const state = this.state();
    const fallbacks = { ...state.fallbacks };
    delete fallbacks[name];
    this.save({ variables: { ...state.variables, [name]: value }, fallbacks });
  }

  remove(name: string, replacement: string | null): void {
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
    const visit = (input: string, seen: ReadonlySet<string>): string => input.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (token, name: string) => {
      if (seen.has(name)) return token;
      const value = state.variables[name] ?? state.fallbacks[name];
      return value === undefined ? token : visit(value, new Set([...seen, name]));
    });
    return visit(text, new Set());
  }

  private normalize(state: GlobalVariablesState | null): GlobalVariablesState {
    return { variables: state?.variables ?? {}, fallbacks: state?.fallbacks ?? {} };
  }
}
