import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ReliveWriteRequest } from './relive-api.service';
import { ReliveApiService } from './relive-api.service';
import { outboundAwaitingFingerprint } from './relive-fingerprint';
import { ReliveFingerprintPrompt } from './relive-fingerprint-prompt.service';

/**
 * Creates a Relive cycle and, when it has supplier steps, shows the fingerprint screen while the
 * hashes are saved. Closing the screen stores the cycle without hashes. The first later run
 * stamps them.
 */
@Injectable({ providedIn: 'root' })
export class ReliveFingerprintFlow {
  private readonly api = inject(ReliveApiService);
  private readonly prompt = inject(ReliveFingerprintPrompt);
  private readonly router = inject(Router);

  async createAndOpen(request: ReliveWriteRequest, options: { transient?: boolean; start?: boolean } = {}): Promise<void> {
    const outbound = outboundAwaitingFingerprint(request.steps);
    const work = async (isClosed: () => boolean) => {
      const created = await firstValueFrom(this.api.create(request, !!options.transient, outbound > 0));
      if (outbound > 0 && !isClosed()) {
        await firstValueFrom(this.api.fingerprint(created.id));
      }
      if (options.start && !isClosed()) {
        await firstValueFrom(this.api.startRun(created.id, { driver: 'AUTOMATIC', unattributedChoices: {} }));
      }
      await this.router.navigate(['/relive', created.id]);
    };
    if (outbound === 0) {
      await work(() => false);
      return;
    }
    await this.prompt.run(outbound, true, work);
  }
}
