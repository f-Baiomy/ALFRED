package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/** One card opened in the drawer: the card, its Linked list (every mention plus direct links), the hint and Claude's open proposal. */
public record CardDetail(@JsonUnwrapped Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed,
                         Proposal proposal) {

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed) {
        this(card, commentCount, links, similarClosed, null);
    }

    public CardDetail {
        links = links == null ? List.of() : List.copyOf(links);
    }
}
