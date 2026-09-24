package com.fathy.alfred.backend.internalcalls.adapter.in.web.dto;

import com.fathy.alfred.backend.internalcalls.domain.model.WsMessage;

import java.util.List;

/** POST /internal-calls/webhook/{id}/ws-messages's body - mirrors backend-calls' own DTO of the same purpose. */
public record WsMessagesWebhookRequestDto(List<WsMessage> messages, Boolean closed, Integer closeCode) {
}
