package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TypeStates;

import java.util.List;
import java.util.Map;

/** Optional: every work item type of the scope with its states and their categories, and the area paths. */
public interface StateCatalog {
    List<TypeStates> states(Connection c, Token t) throws ProviderException;

    /** Every area path of the scope ("Odeysys\\Payments"). */
    default List<String> areas(Connection c, Token t) throws ProviderException {
        return List.of();
    }

    /**
     * The states an item of {@code type} may move to from each state (specs/034: a bundle says before Approve when Azure
     * would refuse a move). Empty when the provider does not say - then nothing is refused in advance.
     */
    default Map<String, List<String>> transitions(Connection c, Token t, String project, String type) throws ProviderException {
        return Map.of();
    }

    /** Every tag used in the scope, for the search's Tags filter (specs/029). */
    default List<String> tags(Connection c, Token t) throws ProviderException {
        return List.of();
    }
}
