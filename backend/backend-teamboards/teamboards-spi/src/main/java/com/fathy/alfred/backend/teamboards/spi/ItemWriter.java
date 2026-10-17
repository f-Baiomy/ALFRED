package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.net.URI;

/**
 * Optional: writes to the tracker (specs/028 R9). Core calls these only for a step of a bundle the user approved, or for
 * the user's own direct action - never on Claude's word alone.
 */
public interface ItemWriter {
    /** Adds a comment (Markdown or HTML); the new comment's id. */
    String comment(Connection c, Token t, String id, String text) throws ProviderException;

    void moveState(Connection c, Token t, String id, String state) throws ProviderException;

    /** Sets one field by its reference name (specs/030); an empty value clears it. A tracker that cannot says so. */
    default void setField(Connection c, Token t, String id, String field, String value) throws ProviderException {
        throw new ProviderException(ProviderException.Kind.BAD_RESPONSE, "This tracker cannot set a field from Alfred");
    }

    /** Creates an item; its id. */
    String create(Connection c, Token t, NewItem item) throws ProviderException;

    void hyperlink(Connection c, Token t, String id, URI url, String label, boolean add) throws ProviderException;

    void tag(Connection c, Token t, String id, String tag, boolean add) throws ProviderException;
}
