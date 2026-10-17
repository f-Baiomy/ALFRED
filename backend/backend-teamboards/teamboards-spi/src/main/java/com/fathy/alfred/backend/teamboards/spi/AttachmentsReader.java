package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/**
 * Optional: a work item's attachments. {@code withData}: download each one within {@link Attachment#MAX_BYTES} and
 * {@link Attachment#MAX_PER_ITEM}; the rest come back listed only (no data).
 */
public interface AttachmentsReader {

    List<Attachment> attachments(Connection c, Token t, String extId, boolean withData) throws ProviderException;
}
