import { ServerSettingsComponent } from './server-settings/server-settings.component';
import { StorageSettingsComponent } from './storage-settings/storage-settings.component';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FilterMode } from '../../core/models/call-filter-settings.model';
import { CallFilterSettingsStateService } from '../../core/state/call-filter-settings-state.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { InternalCallServiceDto, InternalLoggingApiService } from '../../core/services/internal-logging-api.service';
import { DbCaptureSettingsComponent } from '../../components/db-capture/db-capture-settings.component';
import { ActivatedRoute } from '@angular/router';

type Partition = 'server' | 'call-filtering' | 'storage' | 'inbound-logging' | 'database-capture';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [ConfirmDialogComponent, DbCaptureSettingsComponent, ServerSettingsComponent, StorageSettingsComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  readonly state = inject(CallFilterSettingsStateService);
  private readonly internalLoggingApi = inject(InternalLoggingApiService);
  private readonly route = inject(ActivatedRoute, { optional: true });

  readonly activePartition = signal<Partition>('call-filtering');

  readonly newWhitelistHost = signal('');
  readonly newBlacklistHost = signal('');
  readonly savingMode = signal(false);

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
    // "All database settings →" from the Sources bar lands here (?section=database-capture).
    const section = this.route?.snapshot.queryParamMap.get('section');
    if (section === 'server') {
      this.activePartition.set('server');
    }
    if (section === 'storage' || section === 'database') {
      this.activePartition.set('storage');
    }
    if (section === 'database-capture') {
      this.activePartition.set('database-capture');
    }

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
