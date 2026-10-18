import { APP_INITIALIZER, ApplicationConfig, inject, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { alfredKeyInterceptor } from './core/services/alfred-key';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { TEAM_CONNECTOR_PROVIDERS } from './components/team/connectors';
import { CallsStateService } from './core/state/calls-state.service';
import { SecretValuesService } from './core/services/secret-values.service';
import { BULK_SELECTION_STATE, CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE } from './core/state/call-selection.tokens';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    // specs/031: a paired browser names its user with X-Alfred-Key on every request to Alfred (the board lock)
    provideHttpClient(withInterceptors([alfredKeyInterceptor])),
    provideRouter(routes),
    // the Team tab's connectors (specs/027): each folder under components/team/connectors registers itself here
    ...TEAM_CONNECTOR_PROVIDERS,
    // App-wide default: CallCardComponent/BulkActionsBarComponent/HeaderComponent/
    // StatsBarComponent/CallListComponent/JsonPanelComponent read state through these tokens
    // rather than injecting CallsStateService directly, so a session-cycle detail view can
    // override them locally (see SessionCycleDetailComponent) with its own state without
    // touching any of those components.
    { provide: CALL_SELECTION_STATE, useExisting: CallsStateService },
    { provide: BULK_SELECTION_STATE, useExisting: CallsStateService },
    { provide: CALL_LIST_CONTROLS_STATE, useExisting: CallsStateService },
    // Secret global variables are masked in every export (D6) - from app start, not from the
    // first time someone opens the variables drawer.
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => {
        const secrets = inject(SecretValuesService);
        return () => secrets.start();
      },
    },
  ]
};
