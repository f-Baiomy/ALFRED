import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FilterMode } from '../../core/models/call-filter-settings.model';
import { CallFilterSettingsStateService } from '../../core/state/call-filter-settings-state.service';
import { DatabaseStatsStateService } from '../../core/state/database-stats-state.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { InternalLoggingApiService } from '../../core/services/internal-logging-api.service';

type Partition = 'call-filtering' | 'database' | 'inbound-logging';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [ConfirmDialogComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  readonly state = inject(CallFilterSettingsStateService);
  readonly databaseStats = inject(DatabaseStatsStateService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly internalLoggingApi = inject(InternalLoggingApiService);

  readonly activePartition = signal<Partition>('call-filtering');

  readonly newWhitelistHost = signal('');
  readonly newBlacklistHost = signal('');
  readonly savingMode = signal(false);
  readonly clearingCalls = signal(false);
  readonly clearingCycles = signal(false);

  /** null = not loaded yet (or a request is in flight) - the toggle renders disabled/loading until this resolves. */
  readonly inboundLoggingEnabled = signal<boolean | null>(null);
  readonly inboundLoggingLoaded = signal(false);
  readonly savingInboundLogging = signal(false);

  /**
   * The deploy-time flag (settings.md's inbound_logging_enabled) - null until the initial fetch
   * resolves, at which point the nav item either appears or stays hidden for good this session.
   * Deliberately starts hidden-until-confirmed (not shown-then-removed) - see ngOnInit.
   */
  readonly inboundLoggingFeatureEnabled = signal<boolean | null>(null);

  readonly isAcceptAll = computed(() => this.state.settings().mode === 'ACCEPT_ALL');
  readonly isAcceptOnly = computed(() => this.state.settings().mode === 'ACCEPT_ONLY');

  ngOnInit(): void {
    this.state.loadIfNeeded();

    // Fetched once up front (not lazily on nav click) so the "Inbound logging" nav item's
    // visibility is decided before the user could ever click it - a deploy-time flag, so this
    // never changes mid-session.
    this.internalLoggingApi.getEnabled().subscribe((res) => {
      this.inboundLoggingEnabled.set(res.enabled);
      this.inboundLoggingLoaded.set(true);
      this.inboundLoggingFeatureEnabled.set(res.featureEnabled);
    });
  }

  setActivePartition(partition: Partition): void {
    this.activePartition.set(partition);
    if (partition === 'database') {
      this.databaseStats.loadIfNeeded();
    }
  }

  /**
   * Flips whether wildfly-proxy (the reverse-mode mitmproxy in front of WildFly, handling inbound
   * frontend->WildFly traffic) logs calls to backend-internal-calls right now - forwarding itself
   * is never affected, only logging. Same switch toggle-wildfly-reverse-proxy.sh/.bat already
   * control from a terminal.
   */
  toggleInboundLogging(): void {
    const next = !this.inboundLoggingEnabled();
    this.savingInboundLogging.set(true);
    this.internalLoggingApi.setEnabled(next).subscribe((res) => {
      this.inboundLoggingEnabled.set(res.enabled);
      this.savingInboundLogging.set(false);
    });
  }

  async clearAllCalls(): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(
      'Delete every logged call? This cannot be undone.',
      'Clear calls'
    );
    if (!confirmed) return;
    this.clearingCalls.set(true);
    this.databaseStats.clearCalls().subscribe(() => this.clearingCalls.set(false));
  }

  async clearAllCycles(): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(
      'Delete every session cycle and its captured calls? This cannot be undone.',
      'Clear cycles'
    );
    if (!confirmed) return;
    this.clearingCycles.set(true);
    this.databaseStats.clearCycles().subscribe(() => this.clearingCycles.set(false));
  }

  /** SVG donut segments (stroke-dasharray/dashoffset around a shared circle) for the call-status breakdown - empty when there's nothing logged yet, so the template just draws the gray base ring. */
  readonly donutSegments = computed(() => {
    const stats = this.databaseStats.stats();
    if (!stats || stats.calls.total === 0) return [];
    const total = stats.calls.total;
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const buckets: { value: number; className: string }[] = [
      { value: stats.calls.ok, className: 'ok' },
      { value: stats.calls.clientError, className: 'warn' },
      { value: stats.calls.serverError, className: 'err' },
    ];
    let offset = 0;
    return buckets
      .filter((bucket) => bucket.value > 0)
      .map((bucket) => {
        const dash = (bucket.value / total) * circumference;
        const segment = {
          className: bucket.className,
          dasharray: `${dash} ${circumference - dash}`,
          dashoffset: -offset,
        };
        offset += dash;
        return segment;
      });
  });

  formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
  }

  setMode(mode: FilterMode): void {
    if (this.state.settings().mode === mode) return;
    this.savingMode.set(true);
    this.state.setMode(mode).subscribe(() => this.savingMode.set(false));
  }

  addWhitelistUrl(): void {
    const host = this.newWhitelistHost().trim();
    if (!host) return;
    this.state.addWhitelistUrl(host).subscribe(() => this.newWhitelistHost.set(''));
  }

  toggleWhitelistUrl(id: string, enabled: boolean): void {
    this.state.toggleWhitelistUrl(id, enabled).subscribe();
  }

  removeWhitelistUrl(id: string): void {
    this.state.removeWhitelistUrl(id).subscribe();
  }

  addBlacklistUrl(): void {
    const host = this.newBlacklistHost().trim();
    if (!host) return;
    this.state.addBlacklistUrl(host).subscribe(() => this.newBlacklistHost.set(''));
  }

  removeBlacklistUrl(id: string): void {
    this.state.removeBlacklistUrl(id).subscribe();
  }
}
