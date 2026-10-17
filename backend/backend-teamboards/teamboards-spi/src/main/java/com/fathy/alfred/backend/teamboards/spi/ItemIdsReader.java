package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.Set;

/**
 * Optional: every item id the scope holds now, ids only. A refresh compares them with the cache, so an item deleted in
 * the tracker or moved out of the scope leaves the cache too (an incremental fetch never sees it go).
 */
public interface ItemIdsReader {
    Set<String> allIds(Connection c, Token t) throws ProviderException;
}
