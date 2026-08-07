/**
 * A (callId, block) pair is already a stable, unique identity for a panel,
 * so the sessionStorage key derived from it is deterministic - no random
 * session id needed. Opening the same panel's "view in new tab" twice just
 * overwrites the same key with the same data.
 */
export function panelViewStorageKey(callId: string, block: string): string {
  return `alfred_panel_view_${callId}_${block}`;
}
