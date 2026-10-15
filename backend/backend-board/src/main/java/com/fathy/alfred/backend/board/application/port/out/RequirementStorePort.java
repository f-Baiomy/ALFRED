package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Where the requirement check keeps its state (specs/018): each Acceptance item's evidence, and what each call showed
 * about it - one row per item and call, so a call is judged once and the verdict is a count, never a re-read of bodies.
 */
public interface RequirementStorePort {

    /** One call's result for one item. */
    record CallRow(String callId, CallResult result, String reason, Instant at) {
    }

    List<ItemEvidence> evidence(String cycleId);

    Optional<ItemEvidence> evidence(String cycleId, String fileName, String itemKey);

    /** Every item's evidence naming this project and endpoint - the watch's lookup, rebuilt into a cache on change. */
    List<ItemEvidence> evidenceFor(String project, String endpoint);

    /** Every project + endpoint some evidence names (the watch's cache). */
    Set<String> watchedEndpoints();

    /** Saves the evidence and forgets what calls showed about the item (its checks changed). */
    void putEvidence(ItemEvidence evidence);

    boolean deleteEvidence(String cycleId, String fileName, String itemKey);

    /** The calls already judged for the item. */
    Set<String> judgedCalls(String cycleId, String fileName, String itemKey);

    void putResults(String cycleId, String fileName, String itemKey, List<CallRow> rows);

    /** The item's call results at or after {@code since} (every one when null), newest first, at most {@code limit}. */
    List<CallRow> results(String cycleId, String fileName, String itemKey, Instant since, int limit);

    /** Per item ("fileName\nitemKey"): the card the check opened for it, if any. */
    Map<String, String> openedCards(String cycleId);

    void putOpenedCard(String cycleId, String fileName, String itemKey, String cardId);
}
