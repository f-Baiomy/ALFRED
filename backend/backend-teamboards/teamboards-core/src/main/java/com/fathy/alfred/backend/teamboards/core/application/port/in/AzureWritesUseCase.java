package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BundleCheck;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;

import java.util.List;
import java.util.Optional;

/**
 * Consent bundles (specs/028 US4, R9, FR-070..076): every write Alfred makes to the tracker for Claude waits in one
 * bundle on the card - a tick per step - until the user approves; the user's own Team-tab actions run at once and are
 * recorded as DONE bundles. Steps run in order with a result each; a failure stops nothing after it unless it is the
 * CREATE the others need. The token is the vault's; with none, approve answers TOKEN_MISSING and the bundle waits.
 */
public interface AzureWritesUseCase {

    long MAX_FILE = 60L * 1024 * 1024;
    int MAX_STEPS = 20;

    /** {@code extend}: Claude adds its steps to a waiting bundle of the same item instead of starting another. */
    record NewBundle(String boardId, String cardId, String conn, String item, String title, List<WriteStep> steps, String askedIn, Long extend) {
    }

    WriteBundle create(Who who, NewBundle in);

    /** The user's own action (state, comment...) from the Team tab or a card: runs now, recorded as a bundle. */
    WriteBundle direct(String conn, String item, String boardId, String cardId, String title, List<WriteStep> steps);

    Optional<WriteBundle> get(long id);

    List<WriteBundle> list(String boardId, String cardId, String state, int limit);

    /** The user edits a waiting bundle's steps (text, ticks, unmasked). */
    WriteBundle edit(Who who, long id, String title, List<WriteStep> steps);

    /** A built file for an ATTACH step (the export the page made, redacted unless the user ticked "send unmasked"). */
    WriteBundle putFile(Who who, long id, int step, String name, byte[] data);

    /** Runs the ticked steps in order (USER only); the results arrive on /ws/teamboards (what: write). */
    WriteBundle approve(Who who, long id);

    WriteBundle reject(Who who, long id);

    /** Rejects with the user's reason (specs/034), kept on the bundle as its note for Claude to read. */
    default WriteBundle reject(Who who, long id, String reason) {
        return reject(who, id);
    }

    /**
     * What a waiting bundle meets in the tracker now (specs/034): read live with the viewer's token - the item's state,
     * per state/field step the value now, the moves Azure allows and whether it changed since the step was made.
     */
    BundleCheck check(long id);

    /**
     * Claude rewrites a comment step of its own waiting bundle (specs/034, "ask Claude to change it"): the text before
     * it is kept as {@code previous}, Claude's first draft as {@code draft}.
     */
    WriteBundle redraft(Who who, long id, int step, String text);

    /** The user asks Claude to change a waiting bundle's comment: a waiting message in the board's chat. Its id, or empty. */
    Optional<Long> askRedraft(long id, int step, String instruction);

    /** Sends one step again of a bundle that ended PARTIAL (specs/034 "Retry this step"). USER only. */
    WriteBundle retry(Who who, long id, int step);

    /**
     * A card moved (FR-070, FR-075): Verified / Done prepare a "Tell Azure" bundle for each linked item; closed as Not in
     * this flow, a cleanup bundle. Nothing is sent - the user approves on the card.
     */
    void cardStatusChanged(String cardId, String boardId, String from, String to, String resolution, Who who);
}
