import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from './app-config.service';
import { VARIABLE_NAME, VARIABLE_TOKEN } from '../../shared/utils/variable-tokens';
import { reconnectingSocket } from '../state/reconnecting-socket';

export interface GlobalVariable { readonly name: string; readonly value: string; }
export type VariableSourceKind = 'MANUAL' | 'CAPTURE' | 'IMPORT';
export interface VariableSource {
  readonly kind: VariableSourceKind;
  readonly ruleId?: string;
  readonly ruleName?: string;
}
export interface GlobalVariablesState {
  readonly variables: Readonly<Record<string, string>>;
  /** Resolution policy for tokens whose variable was deleted. Missing entry means keep {{name}}. */
  readonly fallbacks: Readonly<Record<string, string>>;
  /** Epoch ms of the last write to each name (active environment). Tombstones kept for deletes. */
  readonly updatedAt: Readonly<Record<string, number>>;
  readonly sources: Readonly<Record<string, VariableSource>>;
  /** Names marked secret - GLOBAL, not per-environment (contract section 1). */
  readonly secrets: readonly string[];
  readonly activeEnvironment: string;
  /** Sorted, active included. */
  readonly environments: readonly string[];
}

export interface VariableExport {
  readonly name: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly fallbacks: Readonly<Record<string, string>>;
}

const EMPTY: GlobalVariablesState = {
  variables: {}, fallbacks: {}, updatedAt: {}, sources: {}, secrets: [],
  activeEnvironment: 'Default', environments: ['Default'],
};

const SECRET_NAME_PATTERN = /token|session|auth|key|password|secret/i;

/** One queued per-name write. Applied to local state the instant it's created; sent in order. */
type VariableOp =
  | { readonly kind: 'upsert'; readonly name: string; readonly value: string }
  | { readonly kind: 'remove'; readonly name: string; readonly replacement: string | null };

@Injectable({ providedIn: 'root' })
export class GlobalVariablesService {
  private readonly http = inject(HttpClient, { optional: true });
  private readonly config = inject(AppConfigService);
  readonly state = signal<GlobalVariablesState>(EMPTY);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  private readonly savingFullState = signal(false);
  private readonly savingOps = signal(false);
  /** True while either a bulk save() or a per-name upsert/remove is in flight or queued. */
  readonly saving = computed(() => this.savingFullState() || this.savingOps());
  readonly error = signal('');
  private pending: GlobalVariablesState | null = null;
  private inFlight = false;
  /** Per-name writes, sent one at a time and in order - see enqueueOp/flushOps. */
  private opQueue: VariableOp[] = [];
  private opInFlight = false;
  /** Set when the queue's head request failed; flushOps stays paused until retry() clears it. */
  private opFailed = false;
  private revision = 0;
  private watched = false;
  private pendingRefresh = false;
  private readonly sortedEntries = computed(() => Object.entries(this.state().variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value })));

  /** Bumped on every applied change (local or server); the drawer/launch-tab badge watches it to
   *  know which names just changed, without keeping its own diffing logic. */
  readonly lastChangedNames = signal<readonly string[]>([]);
  /** focusVariable() bumps this so the component can open the drawer and flash a row even though
   *  the service has no view of the DOM itself (contract section 6: `focusVariable`/`isSecret`). */
  readonly focusRequest = signal<{ readonly name: string; readonly nonce: number } | null>(null);

  load(): void {
    if (this.loaded() || this.loading()) return;
    if (!this.http) { this.loaded.set(true); return; }
    this.loading.set(true);
    const revision = this.revision;
    this.http.get<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`).subscribe({
      next: (state) => {
        // Queued per-name ops (e.g. held after a failed send) are re-applied on top, so a
        // refetch never hides an edit that is still waiting to reach the backend.
        if (this.revision === revision || this.opQueue.length) {
          this.applyServerState(this.opQueue.reduce((acc, queued) => this.applyOp(acc, queued), this.normalize(state)));
        }
        this.loaded.set(true);
        this.loading.set(false);
        this.error.set('');
        if (this.pendingRefresh) { this.pendingRefresh = false; this.refresh(); }
      },
      error: () => { this.loading.set(false); this.error.set('Could not load global variables.'); },
    });
  }

  /**
   * Re-fetch unconditionally. A promotion from a proxy GLOBAL capture (or another client's
   * edit) arrives as a /ws/variables nudge while this panel sits open - without this, only
   * a page reload would ever show it, since load() runs once. Deferred past an in-flight
   * load or save rather than racing it; the deferred flag is consumed when that finishes.
   */
  refresh(): void {
    if (this.loading() || this.saving()) { this.pendingRefresh = true; return; }
    this.loaded.set(false);
    this.load();
  }

  /**
   * One subscription for the app's lifetime (the service is root-provided): every
   * variables-changed nudge refetches. Safe for in-progress drawer edits - a refetch only
   * swaps rows whose text actually changed, so a textarea you are typing in keeps its
   * uncommitted content; only a genuine same-row conflict resolves to the freshest text.
   */
  watchForChanges(): void {
    if (this.watched || !this.http) { this.watched = true; return; }
    this.watched = true;
    reconnectingSocket<unknown>(`${this.config.backendUrl.replace(/^http/, 'ws')}/ws/variables`)
      .subscribe(() => this.refresh());
  }

  entries(): GlobalVariable[] {
    return this.sortedEntries();
  }

  save(state: Partial<GlobalVariablesState> & Pick<GlobalVariablesState, 'variables' | 'fallbacks'>): void {
    this.revision++;
    this.applyLocalState(this.normalize({ ...this.state(), ...state }));
    this.pending = this.state();
    this.flush();
  }

  /** Serialize full-state writes. Rapid edits must never let an old response replace a new value. */
  private flush(): void {
    if (this.inFlight || !this.pending) return;
    if (!this.http) { this.pending = null; this.savingFullState.set(false); return; }
    const next = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.savingFullState.set(true);
    this.http.put<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables`, {
      variables: next.variables,
      fallbacks: next.fallbacks,
    }).subscribe({
      next: () => {
        this.inFlight = false;
        this.error.set('');
        if (this.pending) this.flush();
        else {
          this.savingFullState.set(false);
          if (this.pendingRefresh) { this.pendingRefresh = false; this.refresh(); }
        }
      },
      error: () => {
        this.inFlight = false;
        this.pending = this.state();
        this.savingFullState.set(false);
        this.error.set('Could not save global variables. Your edits are still here; retry before leaving.');
      },
    });
  }

  retry(): void {
    if (this.pending) { this.flush(); return; }
    if (this.opFailed) { this.opFailed = false; this.flushOps(); return; }
    if (!this.loaded()) this.load();
  }

  upsert(name: string, value: string): void {
    if (!VARIABLE_NAME.test(name) || name.startsWith('this.')) throw new Error('Invalid variable name');
    this.enqueueOp({ kind: 'upsert', name, value });
  }

  remove(name: string, replacement: string | null): void {
    if (!VARIABLE_NAME.test(name) || name.startsWith('this.')) throw new Error('Invalid variable name');
    this.enqueueOp({ kind: 'remove', name, replacement });
  }

  /** Applies one op to a state value - shared by the optimistic update and by re-basing onto a fresh server response. */
  private applyOp(state: GlobalVariablesState, op: VariableOp): GlobalVariablesState {
    if (op.kind === 'upsert') {
      const fallbacks = { ...state.fallbacks };
      delete fallbacks[op.name];
      const sources = { ...state.sources, [op.name]: { kind: 'MANUAL' as const } };
      const updatedAt = { ...state.updatedAt, [op.name]: Date.now() };
      return { ...state, variables: { ...state.variables, [op.name]: op.value }, fallbacks, sources, updatedAt };
    }
    const variables = { ...state.variables };
    delete variables[op.name];
    const fallbacks = { ...state.fallbacks };
    if (op.replacement !== null) fallbacks[op.name] = op.replacement;
    else delete fallbacks[op.name];
    const sources = { ...state.sources };
    delete sources[op.name];
    const updatedAt = { ...state.updatedAt, [op.name]: Date.now() };
    return { ...state, variables, fallbacks, sources, updatedAt };
  }

  private enqueueOp(op: VariableOp): void {
    this.revision++;
    this.applyLocalState(this.applyOp(this.state(), op));
    this.opQueue.push(op);
    this.flushOps();
  }

  /**
   * Serialize per-name writes, one at a time and strictly in order - a name PUT and a later
   * name DELETE must land on the backend in the order they were made, or the last write there
   * would not match what the user last saw locally. On success the response (the fresh full
   * state, which may carry an unrelated proxy promotion) becomes the new state, with every
   * op still queued behind this one re-applied on top so an edit already made locally - but
   * not sent yet - is never reverted by a response that predates it.
   */
  private flushOps(): void {
    if (this.opInFlight || this.opFailed || !this.opQueue.length) return;
    if (!this.http) { this.opQueue = []; this.savingOps.set(false); return; }
    const op = this.opQueue[0];
    this.opInFlight = true;
    this.savingOps.set(true);
    const path = `${this.config.backendUrl}/settings/variables/${encodeURIComponent(op.name)}`;
    const request$ = op.kind === 'upsert'
      ? this.http.put<GlobalVariablesState>(path, { value: op.value })
      : this.http.delete<GlobalVariablesState>(op.replacement !== null ? `${path}?fallback=${encodeURIComponent(op.replacement)}` : path);
    request$.subscribe({
      next: (response) => {
        this.opInFlight = false;
        this.opQueue.shift();
        this.applyServerState(this.opQueue.reduce((acc, queued) => this.applyOp(acc, queued), this.normalize(response)));
        this.error.set('');
        if (this.opQueue.length) this.flushOps();
        else {
          this.savingOps.set(false);
          if (this.pendingRefresh) { this.pendingRefresh = false; this.refresh(); }
        }
      },
      error: () => {
        this.opInFlight = false;
        this.opFailed = true;
        this.savingOps.set(false);
        this.error.set('Could not save global variables. Your edits are still here; retry before leaving.');
      },
    });
  }

  /** PUT /settings/variables/{name}/secret - name need not already exist (contract section 1, D6). */
  setSecret(name: string, secret: boolean): void {
    if (!this.http) return;
    this.http.put<GlobalVariablesState>(
      `${this.config.backendUrl}/settings/variables/${encodeURIComponent(name)}/secret`,
      { secret },
    ).subscribe({
      next: (response) => this.applyServerState(this.normalize(response)),
      error: () => this.error.set('Could not update the secret flag.'),
    });
  }

  isSecret(name: string): boolean {
    return this.state().secrets.includes(name) || SECRET_NAME_PATTERN.test(name);
  }

  /** POST /settings/variables/environments - the new environment is NOT activated. */
  createEnvironment(name: string, copyFrom?: string): void {
    if (!this.http) return;
    this.http.post<GlobalVariablesState>(
      `${this.config.backendUrl}/settings/variables/environments`,
      copyFrom ? { name, copyFrom } : { name },
    ).subscribe({
      next: (response) => this.applyServerState(this.normalize(response)),
      error: () => this.error.set(`Could not create environment "${name}".`),
    });
  }

  /** PUT /settings/variables/environments/active - republishes variables.json on the backend. */
  switchEnvironment(name: string): void {
    if (!this.http) return;
    this.http.put<GlobalVariablesState>(
      `${this.config.backendUrl}/settings/variables/environments/active`,
      { name },
    ).subscribe({
      next: (response) => this.applyServerState(this.normalize(response)),
      error: () => this.error.set(`Could not switch to environment "${name}".`),
    });
  }

  /** DELETE /settings/variables/environments/{name} - 400 if active or last, surfaced via error(). */
  deleteEnvironment(name: string): void {
    if (!this.http) return;
    this.http.delete<GlobalVariablesState>(
      `${this.config.backendUrl}/settings/variables/environments/${encodeURIComponent(name)}`,
    ).subscribe({
      next: (response) => this.applyServerState(this.normalize(response)),
      error: () => this.error.set(`Could not delete environment "${name}".`),
    });
  }

  /** GET /settings/variables/environments/{name}/export - caller turns this into a download. */
  exportEnvironment(name: string, onLoad: (payload: VariableExport) => void): void {
    if (!this.http) return;
    this.http.get<VariableExport>(
      `${this.config.backendUrl}/settings/variables/environments/${encodeURIComponent(name)}/export`,
    ).subscribe({
      next: onLoad,
      error: () => this.error.set(`Could not export environment "${name}".`),
    });
  }

  /** POST /settings/variables/import - env created if absent; imported names get source IMPORT. */
  import(payload: { environment: string; variables: Record<string, string>; fallbacks?: Record<string, string>; mode: 'MERGE' | 'REPLACE' }): void {
    if (!this.http) return;
    this.http.post<GlobalVariablesState>(`${this.config.backendUrl}/settings/variables/import`, payload).subscribe({
      next: (response) => this.applyServerState(this.normalize(response)),
      error: () => this.error.set('Could not import variables - check the file is valid.'),
    });
  }

  /** Opens the drawer scrolled to and flashing `name` (contract section 6). The component reacts
   *  to focusRequest(); this service has no DOM access of its own. */
  focusVariable(name: string): void {
    this.focusRequest.set({ name, nonce: Date.now() });
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

  /** Local (optimistic) state change - no diffing against the previous value, since the new
   *  value IS the edit the user just made. */
  private applyLocalState(next: GlobalVariablesState): void {
    this.state.set(next);
  }

  /** State arriving from the server (initial load, refresh, or a mutation's response) - the only
   *  path that can carry a change nobody in this tab made (another tab, a proxy promotion), so
   *  it is the only path that computes which names actually changed for the flash/badge. */
  private applyServerState(next: GlobalVariablesState): void {
    const previous = this.state();
    const changed = new Set<string>();
    for (const name of new Set([...Object.keys(previous.variables), ...Object.keys(next.variables)])) {
      if (previous.variables[name] !== next.variables[name]) changed.add(name);
    }
    this.state.set(next);
    if (changed.size) this.lastChangedNames.set([...changed]);
  }

  private normalize(state: Partial<GlobalVariablesState> | null): GlobalVariablesState {
    return {
      variables: state?.variables ?? {},
      fallbacks: state?.fallbacks ?? {},
      updatedAt: state?.updatedAt ?? {},
      sources: state?.sources ?? {},
      secrets: state?.secrets ?? [],
      activeEnvironment: state?.activeEnvironment ?? 'Default',
      environments: state?.environments ?? ['Default'],
    };
  }
}
