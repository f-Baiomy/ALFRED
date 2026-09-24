/**
 * One WebSocket message logged after interception ran - see backend's WsMessage/data-model.md §8.
 * `type` is `text` or `binary`; a binary message's content rides in `contentBase64` instead of
 * `content`. `action` is undefined (passed through unchanged), `edited`, or `dropped`.
 */
export interface WsMessage {
  readonly seq: number;
  readonly direction: 'client' | 'server';
  readonly tsMillis: number;
  readonly type: 'text' | 'binary';
  readonly content?: string;
  readonly contentBase64?: string;
  readonly originalContent?: string;
  readonly action?: string;
}

export interface WsMessagesPage {
  readonly messages: readonly WsMessage[];
  readonly total: number;
  readonly dropped: number;
}
