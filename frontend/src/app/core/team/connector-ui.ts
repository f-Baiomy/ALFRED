import { InjectionToken, Type } from '@angular/core';

/**
 * What a team-tracker connector adds to the UI (specs/027 contracts/connector-spi.md). Each connector lives in its own
 * folder, components/team/connectors/<kind>/, and registers one of these through TEAM_CONNECTORS; nothing outside that
 * folder imports from it (scripts/check-team-boundaries.mjs).
 */
export type NeutralWord = 'sprint' | 'squad' | 'area' | 'item';

export interface ConnectorUi {
  /** Matches the backend connector's kind(). */
  readonly kind: string;
  readonly label: string;
  readonly icon: string;
  /** How a user finds the base URL and the token for this provider. */
  readonly help: string;
  /** The base URL's example, e.g. https://dev.azure.com/your-org. */
  readonly urlHint: string;
  /** Renders one field's value (e.g. Azure HTML fields); none: plain text. */
  readonly fieldRenderer?: Type<unknown>;
  word(neutral: NeutralWord): string;
}

export const TEAM_CONNECTORS = new InjectionToken<readonly ConnectorUi[]>('TEAM_CONNECTORS');

/** The UI of a kind, or a neutral one for a connector the frontend has no folder for. */
export function connectorUi(all: readonly ConnectorUi[] | null, kind: string): ConnectorUi {
  return all?.find((c) => c.kind === kind) ?? {
    kind, label: kind, icon: '◆', help: '', urlHint: 'https://…',
    word: (w) => ({ sprint: 'Sprint', squad: 'Squad', area: 'Area', item: 'Item' })[w],
  };
}
