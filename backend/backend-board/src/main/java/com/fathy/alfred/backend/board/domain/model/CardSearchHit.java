package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

/** A card found across boards: the card's summary, its latest comment (Claude's Did/Found/Next or the user's) and any open proposal. */
public record CardSearchHit(@JsonUnwrapped Card card, int commentCount, ActivityEntry lastComment, Proposal proposal) {
}
