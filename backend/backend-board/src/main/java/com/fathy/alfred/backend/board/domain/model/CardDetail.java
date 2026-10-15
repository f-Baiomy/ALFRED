package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/**
 * One card opened in the drawer: the card, its Linked list (every mention plus direct links), the hints and Claude's open proposal.
 * {@code similarClosed} is the closed card an Inbox card repeats; {@code similarOpen} the most recently updated other card that is
 * still open on the same signature (null when there is none) - so a finding that is already being worked on is seen at once.
 */
public record CardDetail(@JsonUnwrapped Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed,
                         Proposal proposal, WaitingOn waiting, List<SpecItemLink> specItems, List<CardRef> blockedBy,
                         SimilarOpen similarOpen, int openQuestions, String shortName) {

    /** {@code shortName}: the few words a mention of the card reads (specs/021), null when none was given. */
    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal, WaitingOn waiting,
                      List<SpecItemLink> specItems, List<CardRef> blockedBy, SimilarOpen similarOpen, int openQuestions) {
        this(card, commentCount, links, similarClosed, proposal, waiting, specItems, blockedBy, similarOpen, openQuestions, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal, WaitingOn waiting,
                      List<SpecItemLink> specItems, List<CardRef> blockedBy, SimilarOpen similarOpen) {
        this(card, commentCount, links, similarClosed, proposal, waiting, specItems, blockedBy, similarOpen, 0);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal, WaitingOn waiting,
                      List<SpecItemLink> specItems, List<CardRef> blockedBy) {
        this(card, commentCount, links, similarClosed, proposal, waiting, specItems, blockedBy, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal, WaitingOn waiting) {
        this(card, commentCount, links, similarClosed, proposal, waiting, null, null, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed) {
        this(card, commentCount, links, similarClosed, null, null, null, null, null);
    }

    public CardDetail(Card card, int commentCount, List<MentionRef> links, SimilarClosed similarClosed, Proposal proposal) {
        this(card, commentCount, links, similarClosed, proposal, null, null, null, null);
    }

    public CardDetail {
        links = links == null ? List.of() : List.copyOf(links);
        specItems = specItems == null ? List.of() : List.copyOf(specItems);
        blockedBy = blockedBy == null ? List.of() : List.copyOf(blockedBy);
    }
}
