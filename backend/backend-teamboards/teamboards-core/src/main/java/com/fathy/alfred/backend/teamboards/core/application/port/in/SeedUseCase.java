package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.AttachmentRef;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.spi.model.Link;

import java.util.List;
import java.util.Optional;

/**
 * What /alfred-setup writes a board's brief from (specs/027 FR-035): the item's fields sorted into purpose, steps,
 * acceptance and context by the field maps, the parent's acceptance, a Feature's children as steps, and the attachments
 * by name. Every value whole - nothing is cut.
 */
public interface SeedUseCase {

    record Seed(ItemSummary item, String provider, String purpose, String steps, String acceptance, String context, String parentAcceptance,
                List<String> children, List<AttachmentRef> attachments, List<Link> links, String board) {
    }

    Optional<Seed> seed(String conn, String extId);
}
