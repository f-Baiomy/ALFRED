package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Who made a rule, and why - set only on rules Claude created through the MCP. Claude can only PROPOSE: its rules are
 * saved switched off ({@code proposed} until the user switches the rule on or edits it), and switching on, editing,
 * deleting and the master switch stay the user's. {@code card} is the board card it reproduces ("odeysys#27"), so the
 * Interception tab can show it and say when that card is done.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RuleOrigin(String createdBy, String reason, String card, boolean proposed) {

    public static final String CLAUDE = "CLAUDE";

    public static RuleOrigin proposedByClaude(String reason, String card) {
        return new RuleOrigin(CLAUDE, reason == null ? null : reason.strip(), card == null || card.isBlank() ? null : card.strip(), true);
    }

    /** The user switched it on or edited it - it is a rule like any other now, still marked as Claude's. */
    public RuleOrigin accepted() {
        return new RuleOrigin(createdBy, reason, card, false);
    }
}
