import { Injectable, effect, inject } from '@angular/core';
import { GlobalVariablesService } from './global-variables.service';
import { setSecretValues } from '../../shared/utils/redact';

/**
 * Keeps redact.ts's secret-value list in step with the global variables (D6). Started once at
 * app init (see app.config.ts), and it loads the variables itself: an export made before anyone
 * opened the variables drawer must be masked too, so nothing here may wait for the drawer.
 */
@Injectable({ providedIn: 'root' })
export class SecretValuesService {
  private readonly variables = inject(GlobalVariablesService);

  constructor() {
    effect(() => {
      const state = this.variables.state() as { variables: Record<string, string>; fallbacks: Record<string, string>; secrets?: readonly string[] };
      const names = state.secrets ?? [];
      setSecretValues(names.flatMap((name) => [state.variables[name], state.fallbacks[name]]).filter((v): v is string => typeof v === 'string'));
    });
  }

  start(): void {
    this.variables.load();
    this.variables.watchForChanges();
  }
}
