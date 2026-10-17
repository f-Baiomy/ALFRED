package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/**
 * A team-tracker connector (specs/027 R8, 028). It reads here and through the optional readers, and writes only through
 * {@link ItemWriter} / {@link AttachmentWriter}, which core calls for an approved bundle step or the user's own action.
 * A connector module depends on this SPI only and registers itself as a Spring component; core gets
 * {@code List<Connector>} and derives capabilities from the optional interfaces it implements. Nothing is cached: every
 * read is live, with the token core holds in memory.
 */
public interface Connector {

    /** "azure", "jira"... - also the frontend connector folder's name. */
    String kind();

    String displayName();

    ProviderWords words();

    /** One item, every field and its relations. */
    Item item(Connection c, Token t, String extId) throws ProviderException;

    /** Every work item type, custom ones included. */
    List<ItemTypeInfo> types(Connection c, Token t) throws ProviderException;

    List<Person> people(Connection c, Token t) throws ProviderException;
}
