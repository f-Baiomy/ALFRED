import { Component, computed, input, output, signal } from '@angular/core';
import { maskRelive } from '../../shared/utils/relive-mask';
import { CycleVariable, Step } from '../../shared/utils/relive-types';

export interface VariableRow {
  readonly variable: CycleVariable;
  /** "defined", or "Step <label> → <path>" when some step's own extract rule produces this name. */
  readonly source: string;
  readonly liveValue: string | undefined;
}

/**
 * The Variables tab (FR-019-024; mock.html `varsPanel()`): name, initial value, secret toggle,
 * source (defined, or which step extracts it and from where), a note, and - only while a run is
 * live - the current value, masked the same way everywhere else in Relive shows one (`maskRelive`).
 */
@Component({
  selector: 'app-relive-variables',
  standalone: true,
  templateUrl: './relive-variables.component.html',
})
export class ReliveVariablesComponent {
  readonly variables = input.required<readonly CycleVariable[]>();
  readonly steps = input<readonly Step[]>([]);
  /** Present (even if empty) only while a run is actually live - absent, the live column is hidden entirely. */
  readonly liveValues = input<Readonly<Record<string, string>> | null>(null);

  readonly variablesChange = output<readonly CycleVariable[]>();

  private readonly revealed = signal<ReadonlySet<string>>(new Set());

  readonly rows = computed<readonly VariableRow[]>(() => {
    const live = this.liveValues();
    return this.variables().map((variable) => ({
      variable,
      source: this.sourceOf(variable.name),
      liveValue: live ? live[variable.name] : undefined,
    }));
  });

  private sourceOf(name: string): string {
    for (const step of this.steps()) {
      const rule = step.extract.find((e) => e.as === name);
      if (rule) return `${step.label} → ${rule.path}`;
    }
    return 'defined';
  }

  isRevealed(name: string): boolean {
    return this.revealed().has(name);
  }

  toggleReveal(name: string): void {
    const next = new Set(this.revealed());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.revealed.set(next);
  }

  maskedLiveValue(row: VariableRow): string {
    if (row.liveValue === undefined) return '';
    if (this.isRevealed(row.variable.name)) return row.liveValue;
    if (!row.variable.secret) return row.liveValue;
    return maskRelive(row.liveValue, [row.variable.name], { [row.variable.name]: row.liveValue });
  }

  add(): void {
    const name = `variable${this.variables().length + 1}`;
    this.variablesChange.emit([...this.variables(), { name, value: '', secret: false, note: null }]);
  }

  remove(name: string): void {
    this.variablesChange.emit(this.variables().filter((v) => v.name !== name));
  }

  update(name: string, patch: Partial<CycleVariable>): void {
    this.variablesChange.emit(this.variables().map((v) => (v.name === name ? { ...v, ...patch } : v)));
  }

  rename(oldName: string, newName: string): void {
    if (!newName || newName === oldName) return;
    this.update(oldName, { name: newName });
  }
}
