package com.fathy.alfred.backend.board.domain.model;

/** What a mention points at; the lower-case name is the type in @[type:ref|label]. */
public enum MentionType {
    CALL, STMT, LOG, REDIS, SPEC, CODE, CYCLE, SPACER, CARD, RULE, CHAT,
    /** A work item of the team's tracker, {@code <conn>/<itemId>} (specs/027). */
    WORKITEM
}
