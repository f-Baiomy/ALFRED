import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FilterMode } from '../../core/models/call-filter-settings.model';
import { CallFilterSettingsStateService } from '../../core/state/call-filter-settings-state.service';
import { DatabaseStatsStateService } from '../../core/state/database-stats-state.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { InternalCallServiceDto, InternalLoggingApiService } from '../../core/services/internal-logging-api.service';

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

  /** Every project reverse-proxy fronts (plus the reserved "unknown" bucket), each with its own live enabled state - see internal-logging-api.service.ts. */
  readonly inboundServices = signal<InternalCallServiceDto[]>([]);
  readonly inboundServicesLoaded = signal(false);
  /** Name of the row currently mid-save (disables just that row's button), or null when nothing's in flight. */
  readonly savingInboundService = signal<string | null>(null);

  /**
   * The deploy-time flag (settings.properties's reverse_proxy_enabled) - null until the initial
   * fetch resolves, at which point the nav item either appears or stays hidden for good this
   * session. Deliberately starts hidden-until-confirmed (not shown-then-removed) - see ngOnInit.
   */
  readonly inboundLoggingFeatureEnabled = signal<boolean | null>(null);

  readonly isAcceptAll = computed(() => this.state.settings().mode === 'ACCEPT_ALL');
  readonly isAcceptOnly = computed(() => this.state.settings().mode === 'ACCEPT_ONLY');

  ngOnInit(): void {
    this.state.loadIfNeeded();

    // Fetched once up front (not lazily on nav click) so the "Inbound logging" nav item's
    // visibility is decided before the user could ever click it - a deploy-time flag, so this
    // never changes mid-session.
    this.internalLoggingApi.getFeatureEnabled().subscribe((res) => {
      this.inboundLoggingFeatureEnabled.set(res.enabled);
      if (!res.enabled) return;
      this.internalLoggingApi.getServices().subscribe((services) => {
        this.inboundServices.set(services);
        this.inboundServicesLoaded.set(true);
      });
    });
  }

  setActivePartition(partition: Partition): void {
    this.activePartition.set(partition);
    if (partition === 'database') {
      this.databaseStats.loadIfNeeded();
    }
  }

  /**
   * Flips whether reverse-proxy logs ONE named project's calls to backend-internal-calls right
   * now - forwarding to that project's upstream is never affected, only logging, and every
   * other project's toggle is unaffected. Same per-project switches
   * toggle-wildfly-reverse-proxy.sh/.bat already control from a terminal.
   */
  toggleInboundService(name: string, enabled: boolean): void {
    this.savingInboundService.set(name);
    this.internalLoggingApi.setEnabled(name, enabled).subscribe((services) => {
      this.inboundServices.set(services);
      this.savingInboundService.set(null);
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
