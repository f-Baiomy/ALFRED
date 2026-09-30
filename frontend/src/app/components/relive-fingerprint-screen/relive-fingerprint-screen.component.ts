import { Component, inject } from '@angular/core';
import { ReliveFingerprintPrompt } from '../../core/services/relive-fingerprint-prompt.service';

@Component({
  selector: 'app-relive-fingerprint-screen',
  standalone: true,
  templateUrl: './relive-fingerprint-screen.component.html',
})
export class ReliveFingerprintScreenComponent {
  private readonly prompt = inject(ReliveFingerprintPrompt);
  readonly view = this.prompt.view;

  keepWaiting(): void {
    this.prompt.keepWaiting();
  }

  requestClose(): void {
    this.prompt.requestClose();
  }

  confirmClose(): void {
    this.prompt.confirmClose();
  }
}
