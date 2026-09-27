import { Injectable, inject, signal } from '@angular/core';
import { ReliveApiService } from '../services/relive-api.service';
import { ReliveSocketService } from '../services/relive-socket.service';
import { ReliveCycleSummary } from '../../shared/utils/relive-types';

/** The Relive Cycles list, reloaded whenever `/ws/relive` says a cycle changed - no polling. */
@Injectable({ providedIn: 'root' })
export class ReliveCyclesStateService {
  private readonly api = inject(ReliveApiService);
  private readonly socket = inject(ReliveSocketService);

  readonly cycles = signal<readonly ReliveCycleSummary[]>([]);

  constructor() {
    this.load();
    this.socket.events$.subscribe((event) => {
      if (event.type === 'relive-changed') {
        this.load();
      }
    });
  }

  load(): void {
    this.api.list().subscribe((cycles) => this.cycles.set(cycles));
  }
}
