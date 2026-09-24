package com.fathy.alfred.backend.calls.adapter.in.web.dto;

import com.fathy.alfred.backend.calls.domain.model.WsMessage;

import java.util.List;

/** POST /calls/webhook/{id}/ws-messages's body - see PX/ws_messages.py's MessageBatcher.flush payload shape. */
public record WsMessagesWebhookRequestDto(List<WsMessage> messages, Boolean closed, Integer closeCode) {
}
