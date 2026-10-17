package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.time.Instant;
import java.util.List;
import java.util.function.Consumer;

/**
 * A team-tracker connector (specs/027 R8): read-only by contract - no interface here or in the optional readers declares
 * a write (FR-026). A connector module depends on this SPI only and registers itself as a Spring component; core gets
 * {@code List<Connector>} and derives capabilities from the optional reader interfaces it implements.
 */
public interface Connector {

    /** "azure", "jira"... - also the frontend connector folder's name. */
    String kind();

    String displayName();

    ProviderWords words();

    /** Items of the scope changed after {@code since} (null = full first fetch), page by page so nothing big sits in memory. */
    void changedItems(Connection c, Token t, Instant since, Consumer<List<Item>> page) throws ProviderException;

    Item item(Connection c, Token t, String extId) throws ProviderException;

    /** Every work item type, custom ones included. */
    List<ItemTypeInfo> types(Connection c, Token t) throws ProviderException;

    List<Person> people(Connection c, Token t) throws ProviderException;
}
