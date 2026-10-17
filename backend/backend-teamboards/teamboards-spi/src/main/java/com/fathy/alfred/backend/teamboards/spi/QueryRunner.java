package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: the provider's own read-only query language (Azure: a WIQL SELECT), at most {@code max} items. */
public interface QueryRunner {
    List<Item> query(Connection c, Token t, String query, int max) throws ProviderException;
}
