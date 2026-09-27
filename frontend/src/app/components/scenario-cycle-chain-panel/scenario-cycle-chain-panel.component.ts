import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { buildChainedDrafts, ChainSuggestion, detectChains } from '../../shared/utils/cycle-chain-detect';

/**
 * D2 - "Create scenario from cycle" (pages/session-cycle-detail): lists what cycle-chain-detect.ts
 * found, lets the user toggle each suggestion off before committing, then opens the bulk resend
 * dialog pre-loaded with the chained drafts. Every suggestion starts accepted - that is the whole
 * point of detecting them - so declining one is the exception, not the norm.
 */
@Component({
  selector: 'app-scenario-cycle-chain-panel',
  standalone: true,
  templateUrl: './scenario-cycle-chain-panel.component.html',
})
export class ScenarioCycleChainPanelComponent {
  private readonly dialog = inject(BulkResendDialogService);

  readonly calls = input.required<readonly CallRecord[]>();
  readonly cycleId = input<string | null>(null);
  readonly cycleName = input('Cycle');
  readonly closed = output<void>();

  readonly suggestions = computed<ChainSuggestion[]>(() => detectChains(this.calls()));
  readonly chained = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect(() => this.chained.set(new Set(this.suggestions().map((s) => s.name))), { allowSignalWrites: true });
  }

  isChained(name: string): boolean {
    return this.chained().has(name);
  }

  toggle(name: string): void {
    this.chained.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  describeSource(suggestion: ChainSuggestion): string {
    if (suggestion.useCurrentSession) return `Cookie "${suggestion.from.path}" on ${suggestion.uses.length} later call(s)`;
    return `From call ${suggestion.from.callIndex + 1}'s ${suggestion.from.kind.toLowerCase()} "${suggestion.from.path}" - used on ${suggestion.uses.length} later call(s)`;
  }

  createScenario(): void {
    const { drafts, groups } = buildChainedDrafts(this.calls(), this.cycleId(), this.cycleName(), this.suggestions(), this.chained());
    // start() resets the dialog's groups to {}, so the group must be applied AFTER start().
    this.dialog.start(drafts);
    this.dialog.groups.set(groups);
    this.closed.emit();
  }

  cancel(): void {
    this.closed.emit();
  }
}
