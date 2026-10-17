package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WatchRuleRow;

import java.util.List;

/**
 * A board's watch rules (specs/028 US5, FR-080): a saved search body, run when the board opens, on Refresh, on a hook
 * ping and through the MCP; a match not on the board yet arrives in Incoming once.
 */
public interface WatchRulesUseCase {

    int MAX_RULES = 20;

    List<WatchRuleRow> rules(String boardId);

    WatchRuleRow put(String boardId, Long id, String conn, String name, SearchIn query);

    boolean delete(String boardId, long id);

    /** Runs every rule of the board ({@code source}: OPEN, REFRESH, HOOK, MCP); the number of new arrivals. */
    int run(String boardId, String source);

    /** Runs the rules of every board on this connection (a hook ping). */
    int runForConnection(String conn, String source);
}
