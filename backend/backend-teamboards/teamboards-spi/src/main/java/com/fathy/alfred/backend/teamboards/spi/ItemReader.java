package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: many items at once (at most {@link #MAX} ids, relations included), and an item's comments. */
public interface ItemReader {
    int MAX = 200;

    /** The items found, in the order asked; an id the provider does not have (or hides) is left out. */
    List<Item> items(Connection c, Token t, List<String> ids) throws ProviderException;

    List<Comment> comments(Connection c, Token t, String id) throws ProviderException;
}
