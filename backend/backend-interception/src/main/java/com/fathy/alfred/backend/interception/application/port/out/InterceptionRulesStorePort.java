package com.fathy.alfred.backend.interception.application.port.out;

import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;

import java.util.List;

/**
 * Persistence for rules and for the master switch. Two implementations, selected by
 * {@code alfred.storage.interception.type} exactly like every other slice: SQLite by default,
 * a JSON file as the explicit {@code type=file} opt-out.
 */
public interface InterceptionRulesStorePort {

    /** In stored order, which is priority ascending then insertion order - what the UI lists. */
    List<InterceptionRule> findAll();

    void saveAll(List<InterceptionRule> rules);

    /**
     * The master switch. Separate from every rule's own {@code enabled} flag so that "turn all off"
     * is one write that does not lose which rules the user had on - flipping every rule instead
     * would make turning the feature back on a manual reconstruction job.
     */
    boolean isEnabled();

    void setEnabled(boolean enabled);
}
