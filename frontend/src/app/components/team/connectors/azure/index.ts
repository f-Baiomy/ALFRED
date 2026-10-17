import { Provider } from '@angular/core';
import { ConnectorUi, TEAM_CONNECTORS } from '../../../../core/team/connector-ui';

/** Azure DevOps in the Team tab (specs/027): its words, where to find the token, and its HTML fields. */
export const AZURE_UI: ConnectorUi = {
  kind: 'azure',
  label: 'Azure DevOps',
  icon: '◆',
  urlHint: 'https://dev.azure.com/your-org',
  help: 'Base URL: your organisation, https://dev.azure.com/<org>. Token: User settings → Personal access tokens → New token, '
    + 'scope "Work Items: Read" (and "Project and Team: Read" for teams). Alfred never stores it: it stays in this browser.',
  loadFieldRenderer: () => import('./azure-field.component').then((m) => m.AzureFieldComponent),
  word: (w) => ({ sprint: 'Iteration', squad: 'Team', area: 'Area Path', item: 'Work item' })[w],
};

export const AZURE_CONNECTOR: Provider = { provide: TEAM_CONNECTORS, useValue: AZURE_UI, multi: true };
