import { Provider } from '@angular/core';
import { AZURE_CONNECTOR } from './azure';

/**
 * Every connector the frontend ships (specs/027 R8): one line per connector folder. app.config.ts provides this list
 * and nothing else imports a connector - the Team tab reaches them only through TEAM_CONNECTORS.
 */
export const TEAM_CONNECTOR_PROVIDERS: Provider[] = [AZURE_CONNECTOR];
