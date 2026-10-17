package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;

import java.util.List;
import java.util.Optional;

/**
 * What /alfred-setup and the Task tab write a board's brief from (specs/027 FR-035, 028 FR-039): the item's fields
 * sorted into purpose, steps, acceptance and context by the field maps, the parent's acceptance, a parent type's
 * children as steps, and the attachments by name. Since specs/030 every child in full (fields, comments, done) and the
 * parent chain up to the top. Every value whole - nothing is cut. Read from the board's saved copy
 * when there is one, else live.
 */
public interface SeedUseCase {

    /** An attachment the item names, listed by name and link; {@code held}: the board has a file of that name. */
    record AttachmentRef(String name, long size, String url, boolean held) {
    }

    /**
     * A child of the item, read in full (specs/030 FR-003): its fields sorted by the same field maps as the item's own,
     * its comments, and {@code done} when its state is Resolved, Completed or Removed. {@code grandchildren} are lines
     * ({@code id · type · title · state}) only.
     */
    record SeedChild(String id, String type, String title, String state, String category, boolean done, String assignee, String url,
                     String purpose, String steps, String acceptance, String context, List<SeedComment> comments, List<String> grandchildren) {
    }

    /** One comment of an item, whole. */
    record SeedComment(String by, String at, String text) {
    }

    /** One item of the parent chain, nearest first, up to the top (an Epic): its purpose and acceptance. */
    record SeedParent(String id, String type, String title, String state, String url, String purpose, String acceptance) {
    }

    /**
     * {@code children}: one line per child ({@code id · type · title · state}), kept for older readers;
     * {@code childItems} the same children in full, {@code parents} the chain up, {@code comments} the item's own.
     */
    record Seed(Item item, String provider, String purpose, String steps, String acceptance, String context, String parentAcceptance,
                List<String> children, List<AttachmentRef> attachments, List<Link> links, String board,
                List<SeedChild> childItems, List<SeedParent> parents, List<SeedComment> comments) {
        public Seed(Item item, String provider, String purpose, String steps, String acceptance, String context, String parentAcceptance,
                    List<String> children, List<AttachmentRef> attachments, List<Link> links, String board) {
            this(item, provider, purpose, steps, acceptance, context, parentAcceptance, children, attachments, links, board, List.of(), List.of(), List.of());
        }
    }

    Optional<Seed> seed(String conn, String extId);
}
