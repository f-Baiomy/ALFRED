package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

/** Optional: live search (specs/028). The caller stores nothing of the answer. */
public interface ItemSearcher {
    ItemPage search(Connection c, Token t, ItemQuery q) throws ProviderException;
}
