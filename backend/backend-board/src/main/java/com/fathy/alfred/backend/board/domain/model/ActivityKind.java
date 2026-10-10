package com.fathy.alfred.backend.board.domain.model;

/** One entry in a card's history: a comment, or one recorded change. */
public enum ActivityKind {
    COMMENT, CREATED, STATUS, KIND, SCOPE, FLAGS, RESOLUTION, REASON, TITLE, DESCRIPTION, LINK_ADDED, LINK_REMOVED, CYCLE, PROJECT, SPEC_REPLACED, REOPENED, IMPORTED, DELETED, PROPOSED, PROPOSAL_ACCEPTED, PROPOSAL_DISMISSED
}
