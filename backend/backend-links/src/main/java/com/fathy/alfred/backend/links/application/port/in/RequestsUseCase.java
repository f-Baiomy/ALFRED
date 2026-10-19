package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.RequestState;

import java.util.List;

/**
 * Writes from a reader are requests the owner approves (D10-D14). The reader sends one while the owner is online (an
 * offline owner gets nothing: the page keeps the draft, D14); the owner answers once - the first answer wins (D11) - or
 * the stream's auto-accept takes it (D12); anything accepted can be undone; the sender can withdraw a waiting one (D13).
 */
public interface RequestsUseCase {

    /**
     * {@code via} is the slug of the link the stream came through ({@code target} is that owner's own id); {@code author}
     * is "this Alfred" or "this Alfred (Claude)".
     */
    record SendIn(String via, String streamId, RequestKind kind, String target, String targetLabel, String text, String extra, boolean claude) {
    }

    /** Reader side: sends a request now (throws OFFLINE when the owner cannot be reached). */
    LinkRequest send(SendIn in);

    /** Reader side: takes back a request that is still waiting. */
    LinkRequest withdraw(String id);

    /** Owner side. Each throws ANSWERED (409) when the request was already answered or withdrawn. */
    LinkRequest accept(String id);

    LinkRequest reject(String id, String note);

    LinkRequest undo(String id);

    List<LinkRequest> requests(Boolean incoming, RequestState state, String linkId, int limit);

    /** Waiting requests to this Alfred - the ⇄n in the tab title (D11). */
    int waiting();
}
