import { Component, computed, input, output, signal } from '@angular/core';
import { maskRelive } from '../../shared/utils/relive-mask';
import { StepChain, applyStepChains, detectStepChains, removeStepChains } from '../../shared/utils/relive-chains';
import { CycleVariable, ReliveSettings, Step } from '../../shared/utils/relive-types';

/**
 * The Steps tab's "Session" card: what keeps an Automatic run logged in (relive-session.ts).
 * Lists the values the recording handed from one step to a later one (relive-chains.ts) - "Use"
 * makes the producing step extract each one and the run swap it in - and the two cycle settings:
 * carrying cookies between steps, and replayed supplier calls ignoring fresh credentials.
 */
@Component({
  selector: 'app-relive-session-panel',
  standalone: true,
  templateUrl: './relive-session-panel.component.html',
})
export class ReliveSessionPanelComponent {
  readonly steps = input.required<readonly Step[]>();
  readonly settings = input.required<ReliveSettings>();
  readonly variables = input<readonly CycleVariable[]>([]);

  readonly stepsChange = output<readonly Step[]>();
  readonly settingsChange = output<ReliveSettings>();

  readonly expanded = signal(false);

  readonly chains = computed<readonly StepChain[]>(() => detectStepChains(this.steps(), this.variables().map((v) => v.name)));
  /** Not used yet. A cookie counts as handled while the jar carries it. */
  readonly pending = computed(() => this.chains().filter((c) => !c.applied && !(c.cookie && this.carryCookies())));
  /** Used now, and not just carried by the cookie jar - what "Clear all" undoes. */
  readonly used = computed(() => this.chains().filter((c) => c.applied));
  readonly carryCookies = computed(() => this.settings().carryCookies !== false);
  readonly ignoreCredentials = computed(() => this.settings().replayIgnoresCredentials !== false);

  private readonly labels = computed(() => new Map(this.steps().map((s) => [s.key, s.label || `${s.recording.method} ${pathOf(s.recording.url)}`])));

  label(stepKey: string): string {
    return this.labels().get(stepKey) ?? stepKey;
  }

  whereText(chain: StepChain): string {
    const places = [...new Set(chain.uses.map((u) => u.where))];
    return `${places.join(', ')} of ${chain.uses.length} later step${chain.uses.length === 1 ? '' : 's'}`;
  }

  masked(value: string): string {
    return maskRelive(value, ['value'], { value });
  }

  use(chains: readonly StepChain[]): void {
    if (chains.length) this.stepsChange.emit(applyStepChains(this.steps(), chains));
  }

  stopUsing(chains: readonly StepChain[]): void {
    if (chains.length) this.stepsChange.emit(removeStepChains(this.steps(), chains));
  }

  /** A cookie the jar carries counts as on and cannot be unticked - turning carrying off frees it. */
  carriedByJar(chain: StepChain): boolean {
    return chain.cookie && !chain.applied && this.carryCookies();
  }

  toggle(chain: StepChain, on: boolean): void {
    if (on) this.use([chain]);
    else this.stopUsing([chain]);
  }

  setCarryCookies(on: boolean): void {
    this.settingsChange.emit({ ...this.settings(), carryCookies: on });
  }

  setIgnoreCredentials(on: boolean): void {
    this.settingsChange.emit({ ...this.settings(), replayIgnoresCredentials: on });
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
