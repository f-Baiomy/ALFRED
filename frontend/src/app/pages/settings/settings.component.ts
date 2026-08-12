import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FilterMode } from '../../core/models/call-filter-settings.model';
import { CallFilterSettingsStateService } from '../../core/state/call-filter-settings-state.service';

type Partition = 'call-filtering';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [],
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  readonly state = inject(CallFilterSettingsStateService);

  readonly activePartition = signal<Partition>('call-filtering');

  readonly newWhitelistHost = signal('');
  readonly newBlacklistHost = signal('');
  readonly savingMode = signal(false);

  readonly isAcceptAll = computed(() => this.state.settings().mode === 'ACCEPT_ALL');
  readonly isAcceptOnly = computed(() => this.state.settings().mode === 'ACCEPT_ONLY');

  ngOnInit(): void {
    this.state.loadIfNeeded();
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
