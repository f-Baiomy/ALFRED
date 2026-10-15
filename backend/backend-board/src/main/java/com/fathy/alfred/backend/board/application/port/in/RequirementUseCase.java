package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict;

import java.util.List;

/**
 * The requirement check (specs/018): each Acceptance item's evidence, and where each item stands by the calls - worked
 * out in code as calls arrive, so a feature the calls show is not built is a card at once, with no model and no person
 * in the way.
 */
public interface RequirementUseCase {

    /** One item: its text, the user's mark (if any), the evidence and the verdict. */
    record Requirement(String fileName, String itemKey, String text, String mark, ItemEvidence evidence, ItemVerdict verdict,
                       Integer cardNumber, String cardStatus, String shortName) {

        /** {@code shortName}: the few words a mention of the item reads (specs/021), null when none was given. */
        public Requirement(String fileName, String itemKey, String text, String mark, ItemEvidence evidence, ItemVerdict verdict,
                           Integer cardNumber, String cardStatus) {
            this(fileName, itemKey, text, mark, evidence, verdict, cardNumber, cardStatus, null);
        }
    }

    /** One call judged for an item: what it showed and why (specs/021, the item's calls in the spec viewer). */
    record ItemCall(String callId, ItemVerdict.CallResult result, String reason, java.time.Instant at) {
    }

    record NameChange(CardChange.Outcome outcome, String message) {
    }

    /** Every item of a cycle with its verdict, and the counts per verdict. */
    record Requirements(String cycleId, List<Requirement> items, java.util.Map<ItemVerdict.Verdict, Integer> counts) {
    }

    record EvidenceChange(CardChange.Outcome outcome, ItemEvidence evidence, String message) {
    }

    List<ItemEvidence> evidence(String cycleId);

    EvidenceChange putEvidence(Actor actor, ItemEvidence evidence);

    EvidenceChange deleteEvidence(Actor actor, String cycleId, String fileName, String itemKey);

    /** Judges what is new, then the verdicts. */
    Requirements requirements(String cycleId);

    /** The calls judged for one item, newest first. */
    List<ItemCall> itemCalls(String cycleId, String fileName, String itemKey, int limit);

    /** An item's short name (specs/021); Claude may give one only to an item that has none. Blank clears it. */
    NameChange setShortName(Actor actor, String cycleId, String fileName, String itemKey, String shortName);
}
