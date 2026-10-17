package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * An Alfred board opened from a work item (specs/027 US8/US9): the link /alfred-setup sets, what changed in the tracker
 * since, and the item's attachments the board does not hold yet.
 */
public interface LinksUseCase {

    enum LinkOutcome { OK, NOT_FOUND, ALREADY_LINKED, INVALID, TOKEN_MISSING, TOKEN_REJECTED, UNREACHABLE }

    /** One field that changed in the tracker after setup (or after the user last saved or dismissed). */
    record FieldChangeRow(String field, String from, String to, String by, String at) {
    }

    /** An attachment the item names, listed by name and link; {@code held}: the board has a file of that name. */
    record AttachmentRef(String name, long size, String url, boolean held) {
    }

    record LinkView(String board, String conn, String extId, String provider, Map<String, String> snapshot, List<FieldChangeRow> changedSinceSetup,
                    List<AttachmentRef> attachments) {
    }

    /** {@code attached}: files now on the board; {@code notAttached}: name and why. */
    record LinkResult(LinkOutcome outcome, String message, List<String> attached, List<String> notAttached) {
        public static LinkResult of(LinkOutcome outcome, String message) {
            return new LinkResult(outcome, message, List.of(), List.of());
        }
    }

    /** Links a board to the item (snapshot from the cache) and moves the attachments its start fetched onto the board. */
    LinkResult link(String board, String conn, String extId);

    Optional<LinkView> linkOf(String board);

    /** The user saved or dismissed what changed: the snapshot becomes the item as cached now. */
    boolean seen(String board);

    /** The board is gone: its link goes, so the item offers Start again. */
    boolean unlink(String board);

    /** Downloads the linked item's attachments with the viewer's token onto the board (those it does not hold). */
    LinkResult fetchAttachments(String board, Token token);
}
