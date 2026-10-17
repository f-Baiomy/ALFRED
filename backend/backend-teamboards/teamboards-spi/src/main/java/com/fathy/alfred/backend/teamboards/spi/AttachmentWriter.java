package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

/** Optional: attaches a file to an item (an approved bundle step only). */
public interface AttachmentWriter {
    void attach(Connection c, Token t, String id, String name, byte[] data) throws ProviderException;
}
