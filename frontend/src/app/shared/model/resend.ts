/** Resend feature models for frontend state and API interaction. */

export interface ResendEditedHeaders {
  [headerName: string]: boolean;
}

export interface ResendMetadata {
  call_id: string;
  resend_available: boolean;
}

export interface ResendRequest {
  id: string;
  original_call_id: string;
  timestamp: string;
  edited_headers?: ResendEditedHeaders;
}

export interface ResendOutcome {
  id: string;
  new_call_id: string;
  resend_request_id: string;
  original_call_id: string;
  timestamp: string;
}

export interface ResendEditorState {
  originalCallId: string;
  editedHeaders: Set<string>;
  requestBody?: string;
}
