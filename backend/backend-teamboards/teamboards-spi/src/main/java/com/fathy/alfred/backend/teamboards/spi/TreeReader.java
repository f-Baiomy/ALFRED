package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TreeRef;

import java.util.List;

/**
 * Optional: an item's tree - every ancestor, every descendant, and one hop of its other links - as references, at most
 * {@code max} of them (the caller asks the user before going past it). The root itself is not in the list.
 */
public interface TreeReader {
    List<TreeRef> tree(Connection c, Token t, String rootId, int max) throws ProviderException;
}
