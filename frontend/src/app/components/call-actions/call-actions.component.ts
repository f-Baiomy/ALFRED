import { Component, computed, inject, input, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { PinService } from '../../core/services/pin.service';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { buildCurlCommand } from '../../shared/utils/curl-builder';
import { downloadJson } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';

/** Pin / copy-as-cURL / download-as-JSON / export-as-Markdown actions for a single call. */
@Component({
  selector: 'app-call-actions',
  standalone: true,
  templateUrl: './call-actions.component.html',
})
export class CallActionsComponent {
  private readonly pinService = inject(PinService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);

  readonly call = input.required<CallRecord>();
  readonly curlCopyFeedback = signal(false);
  readonly exportLoading = signal(false);

  readonly isPinned = computed(() => this.pinService.isPinned(this.call()));

  togglePin(): void {
    this.pinService.toggle(this.call());
  }

  copyAsCurl(): void {
    navigator.clipboard.writeText(buildCurlCommand(this.call())).then(() => {
      this.curlCopyFeedback.set(true);
      setTimeout(() => this.curlCopyFeedback.set(false), 1200);
    });
  }

  downloadAsJson(): void {
    downloadJson(this.call(), `${callKey(this.call())}.json`);
  }

  exportAsMarkdown(): void {
    const call = this.call();
    this.exportLoading.set(true);
    this.exportApi.fetchMetadata(call).subscribe({
      next: (metadata) => {
        this.exportLoading.set(false);
        this.exportDialog.open(call, metadata);
      },
      error: () => {
        // Backend couldn't extract metadata (or is unreachable) - still let
        // the user fill the form in manually rather than blocking the export.
        this.exportLoading.set(false);
        this.exportDialog.open(call, null);
      },
    });
  }
}
