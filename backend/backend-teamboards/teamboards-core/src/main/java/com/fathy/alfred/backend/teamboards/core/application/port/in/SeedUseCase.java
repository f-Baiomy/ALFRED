package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;

import java.util.List;
import java.util.Optional;

/**
 * What /alfred-setup and the Task tab write a board's brief from (specs/027 FR-035, 028 FR-039): the item's fields
 * sorted into purpose, steps, acceptance and context by the field maps, the parent's acceptance, a parent type's
 * children as steps, and the attachments by name. Every value whole - nothing is cut. Read from the board's saved copy
 * when there is one, else live.
 */
public interface SeedUseCase {

    /** An attachment the item names, listed by name and link; {@code held}: the board has a file of that name. */
    record AttachmentRef(String name, long size, String url, boolean held) {
    }

    record Seed(Item item, String provider, String purpose, String steps, String acceptance, String context, String parentAcceptance,
                List<String> children, List<AttachmentRef> attachments, List<Link> links, String board) {
    }

    Optional<Seed> seed(String conn, String extId);
}
