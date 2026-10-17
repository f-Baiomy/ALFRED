package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/**
 * Optional: a work item's attachments. {@code withData}: download each one within {@link Attachment#MAX_BYTES} and
 * {@link Attachment#MAX_PER_ITEM}; the rest come back listed only (no data).
 */
public interface AttachmentsReader {

    List<Attachment> attachments(Connection c, Token t, String extId, boolean withData) throws ProviderException;

    /** The attachments the cached item names (no network, no token, no data): what a board lists before anyone fetches them. */
    default List<Attachment> listedIn(Item item) {
        return List.of();
    }

    /** One listed attachment's content (at most {@link Attachment#MAX_BYTES}); null when it is bigger or not the provider's. */
    default byte[] content(Connection c, Token t, Attachment a) throws ProviderException {
        return null;
    }
}
