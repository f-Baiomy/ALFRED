package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/** One card opened in the drawer: the card, its Linked list (every mention plus direct links), the hint and Claude's open proposal. */
public record CardDetail(@JsonUnwrapped Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed,
                         Proposal proposal, WaitingOn waiting, List<SpecItemLink> specItems, List<CardRef> blockedBy) {

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal, WaitingOn waiting) {
        this(card, commentCount, links, similarClosed, proposal, waiting, null, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed) {
        this(card, commentCount, links, similarClosed, null, null, null, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal) {
        this(card, commentCount, links, similarClosed, proposal, null, null, null);
    }

    public CardDetail {
        links = links == null ? List.of() : List.copyOf(links);
        specItems = specItems == null ? List.of() : List.copyOf(specItems);
        blockedBy = blockedBy == null ? List.of() : List.copyOf(blockedBy);
    }
}
