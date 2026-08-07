/**
 * Naming helpers shared by both sides of the "edit in a new tab" bridge:
 * the panel that opens the tab (JsonEditorBridgeService) and the editor
 * page itself (JsonEditorPageComponent). Kept as pure functions so both
 * sides derive identical keys from the same session id without either one
 * hardcoding the other's string format.
 */

export function createEditorSessionId(): string {
  return crypto.randomUUID();
}

export function editorStorageKey(sessionId: string): string {
  return `alfred_json_editor_${sessionId}`;
}

export function editorChannelName(sessionId: string): string {
  return `alfred-json-editor-${sessionId}`;
}
