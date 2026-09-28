import { Component, computed, input, output, signal } from '@angular/core';
import { externalReach } from '../../shared/utils/relive-external-reach';
import { validateCycle } from '../../shared/utils/relive-validate';
import { OnFailurePolicy, OnDifferencesPolicy, ReliveCycle, ReliveDriver } from '../../shared/utils/relive-types';

export interface ReliveStartRequest {
  readonly driver: ReliveDriver;
}

/**
 * The pre-run check (FR-016/017; mock.html `openPrerun()`/`policySection()`): validation
 * findings, what may or will reach an external system, and the "when something goes wrong"
 * policy - Start stays disabled while a BLOCK finding remains, and while any LIVE call is
 * unconfirmed.
 */
@Component({
  selector: 'app-relive-prerun-summary',
  standalone: true,
  templateUrl: './relive-prerun-summary.component.html',
})
export class ReliveRerunSummaryComponent {
  readonly open = input.required<boolean>();
  readonly cycle = input<ReliveCycle | null>(null);

  readonly closed = output<void>();
  readonly start = output<ReliveStartRequest>();
  readonly cycleChange = output<ReliveCycle>();
  /** "Define it" on a fixable finding - the host decides what "fixing" means (usually: switch to
   *  the Variables tab and prefill a name). */
  readonly fixFinding = output<{ code: string; stepKey: string | null }>();

  readonly driver = signal<ReliveDriver>('AUTOMATIC');
  readonly liveConfirmed = signal(false);

  readonly findings = computed(() => {
    const cycle = this.cycle();
    return cycle ? validateCycle(cycle) : [];
  });

  readonly blockingFindings = computed(() => this.findings().filter((f) => f.severity === 'BLOCK'));
  readonly warningFindings = computed(() => this.findings().filter((f) => f.severity === 'WARN'));

  readonly externalItems = computed(() => {
    const cycle = this.cycle();
    return cycle ? [...externalReach(cycle).entries()].map(([key, entry]) => ({ key, ...entry })) : [];
  });

  readonly canStart = computed(() => this.blockingFindings().length === 0 && (this.externalItems().length === 0 || this.liveConfirmed()));

  setDriver(driver: ReliveDriver): void {
    this.driver.set(driver);
  }

  toggleLiveConfirmed(checked: boolean): void {
    this.liveConfirmed.set(checked);
  }

  setOnFailure(policy: OnFailurePolicy): void {
    const cycle = this.cycle();
    if (!cycle) return;
    this.cycleChange.emit({ ...cycle, settings: { ...cycle.settings, onFailure: policy } });
  }

  setOnDifferences(policy: OnDifferencesPolicy): void {
    const cycle = this.cycle();
    if (!cycle) return;
    this.cycleChange.emit({ ...cycle, settings: { ...cycle.settings, onDifferences: policy } });
  }

  requestFix(code: string, stepKey: string | null): void {
    this.fixFinding.emit({ code, stepKey });
  }

  requestStart(): void {
    if (!this.canStart()) return;
    this.start.emit({ driver: this.driver() });
    this.close();
  }

  close(): void {
    this.closed.emit();
  }
}
