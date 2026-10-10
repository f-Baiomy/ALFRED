package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/** A board row: the card without its description and history, plus what the row shows. */
public record CardSummary(@JsonUnwrapped Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed) {

    public CardSummary {
        mentionChips = mentionChips == null ? List.of() : List.copyOf(mentionChips);
    }
}
