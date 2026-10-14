package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Ask;

import java.util.Optional;

/** Ask Claude from a snippet or the editor (specs/017 R24, R38); Claude answers through its MCP tools. */
public interface AsksUseCase {

    /** {@code data}: JSON text or null. Sent to the cycle's chat; refused when no chat handles the cycle. */
    record NewAsk(String project, String cycleId, String cardId, String snippetId, String kind, String question, String data) {
    }

    /** The ask, or why it could not be sent ({@code error}: invalid / not-found / conflict). */
    record Sent(Ask ask, String error, String message) {
    }

    Sent ask(Actor actor, NewAsk ask);

    Optional<Ask> get(String id);

    /** Claude's answer; the asker hears it at once. Only Claude answers; an answered ask keeps its first answer. */
    Sent answer(Actor actor, String id, String text);

    /** The asker gave up (its page closed or it pressed Stop). */
    Sent cancel(String id);
}
