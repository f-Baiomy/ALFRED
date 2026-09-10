import { Component, input, output } from '@angular/core';
import { InternalCallServiceDto } from '../../core/services/internal-logging-api.service';
import { EXTERNAL_SOURCE_KEY } from '../../shared/utils/call-utils';

/**
 * Replaces the old three-option External/Internal/Both dropdown with a per-source pill row: one
 * pill for "External" plus one per configured internal project (including its reserved "unknown"
 * bucket) - each independently toggleable in the view (click the pill body) and, for an internal
 * project, independently toggleable for live logging too (the small switch - same endpoint
 * Settings' "Inbound logging" panel uses). Reused verbatim on both the dashboard and a
 * session-cycle detail page, same pattern as HeaderComponent - only the backing state service
 * differs.
 *
 * Renders nothing beyond the "External" pill when `featureEnabled()` is false (no inbound
 * projects configured for this deployment at all) - there being no internal pills to show is
 * itself the signal, no separate hidden-entirely state needed like Settings' nav item.
 */
@Component({
  selector: 'app-sources-bar',
  standalone: true,
  templateUrl: './sources-bar.component.html',
})
export class SourcesBarComponent {
  readonly selected = input.required<ReadonlySet<string>>();
  readonly internalServices = input<readonly InternalCallServiceDto[]>([]);
  readonly featureEnabled = input(false);

  readonly toggleSource = output<string>();
  readonly toggleLogging = output<{ name: string; enabled: boolean }>();

  readonly externalKey = EXTERNAL_SOURCE_KEY;

  isSelected(key: string): boolean {
    return this.selected().has(key);
  }

  selectAll(): void {
    for (const key of this.allKeys()) {
      if (!this.isSelected(key)) this.toggleSource.emit(key);
    }
  }

  clearAll(): void {
    for (const key of this.allKeys()) {
      if (this.isSelected(key)) this.toggleSource.emit(key);
    }
  }

  private allKeys(): string[] {
    return [this.externalKey, ...this.internalServices().map((s) => s.name)];
  }

  onToggleLogging(name: string, currentlyEnabled: boolean, event: Event): void {
    event.stopPropagation();
    this.toggleLogging.emit({ name, enabled: !currentlyEnabled });
  }
}
