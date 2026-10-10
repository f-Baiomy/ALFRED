import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { StorageApiService } from '../../core/services/storage-api.service';
import { DiskState } from '../../core/models/storage.model';
import { formatBytes } from '../../shared/utils/storage-budget';

/**
 * The storage page's "warn me when the disk is low" rule, on every tab: asked once when Alfred opens (no polling),
 * shown only while the disk is under the limit, dismissible for this visit.
 */
@Component({
  selector: 'app-low-disk-banner',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (state(); as s) {
      @if (s.lowDisk && !dismissed()) {
        <div class="st-low-disk st-low-disk-global" role="alert">
          <b>The disk is almost full</b> - {{ fmt(s.freeBytes) }} free, under the {{ s.warnGb }} GB warning.
          <a routerLink="/settings" [queryParams]="{ section: 'storage' }" class="bulk-btn secondary">Free space…</a>
          <button type="button" class="st-x" aria-label="Dismiss" (click)="dismissed.set(true)">×</button>
        </div>
      }
    }
  `,
})
export class LowDiskBannerComponent implements OnInit {
  private readonly api = inject(StorageApiService);
  readonly state = signal<DiskState | null>(null);
  readonly dismissed = signal(false);
  readonly fmt = formatBytes;

  ngOnInit(): void {
    this.api.disk().subscribe({ next: (s) => this.state.set(s), error: () => undefined });
  }
}
