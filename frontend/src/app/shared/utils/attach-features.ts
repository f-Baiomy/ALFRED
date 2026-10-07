import { DbCaptureSettings } from '../../core/models/db-capture.model';

/**
 * What an "attach the agent" ask carries, shared by Settings → Database capture and the ◆ popover in the Sources bar
 * so the two never drift: every capture feature, plus the proxy feature unless the project's settings turned it off.
 */
export function attachFeatures(settings: DbCaptureSettings | null | undefined): readonly string[] {
  return settings?.attachProxy === false ? ['db', 'logs', 'redis'] : ['proxy', 'db', 'logs', 'redis'];
}

/** The one-line account of an ask, shown next to the picker until the Server card has the supervisor's outcome. */
export const ATTACH_NOTES = {
  asking: 'asking the supervisor…',
  asked: 'asked - see Settings → Server for the outcome',
  failed: 'Could not ask the supervisor.',
} as const;
