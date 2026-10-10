package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Locale;
import java.util.Map;

/**
 * Shared by the board's controllers: who is asking ({@code X-Alfred-Actor: claude} marks Claude's MCP tools, research
 * R11) and how an outcome becomes a response - 400 invalid input, 404 unknown, 409 refused (Claude's limits, an illegal
 * transition, a duplicate of a dismissed card, a paused board), each with {@code {error, message}}.
 */
final class BoardWeb {

    static final String ACTOR_HEADER = "X-Alfred-Actor";

    private BoardWeb() {
    }

    static Actor actor(String header) {
        return header != null && header.strip().equalsIgnoreCase("claude") ? Actor.CLAUDE : Actor.USER;
    }

    static ResponseEntity<?> respond(CardChange change, HttpStatus okStatus) {
        if (change.outcome() == CardChange.Outcome.OK) {
            return change.card() == null ? ResponseEntity.noContent().build() : ResponseEntity.status(okStatus).body(change.card());
        }
        return refused(change.outcome(), change.message());
    }

    static ResponseEntity<?> refused(CardChange.Outcome outcome, String message) {
        HttpStatus status = switch (outcome) {
            case OK -> HttpStatus.OK;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case INVALID -> HttpStatus.BAD_REQUEST;
            default -> HttpStatus.CONFLICT;
        };
        return ResponseEntity.status(status).body(Map.of("error", outcome.name().toLowerCase(Locale.ROOT).replace('_', '-'),
                "message", message == null ? "" : message));
    }

    static MentionType mentionType(String name) {
        return MentionType.valueOf(name.strip().toUpperCase(Locale.ROOT));
    }

    static MentionRef ref(String type, String ref, String label) {
        return new MentionRef(mentionType(type), ref.strip(), label.strip());
    }
}
