package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/** A board row: the card without its description and history, plus what the row shows. */
public record CardSummary(@JsonUnwrapped Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed,
                          Proposal proposal, WaitingOn waiting, List<CardRef> blockedBy, int openQuestions, String advice, String shortName,
                          Advice adviceDetail) {

    /** {@code adviceDetail}: the advice with its triage facts - confidence, what Claude checked, Inbox rank, group to merge. */
    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal,
                       WaitingOn waiting, List<CardRef> blockedBy, int openQuestions, String advice, String shortName) {
        this(card, commentCount, mentionChips, similarClosed, proposal, waiting, blockedBy, openQuestions, advice, shortName, null);
    }

    /** {@code shortName}: the few words a mention of the card reads (specs/021), null when none was given. */
    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal,
                       WaitingOn waiting, List<CardRef> blockedBy, int openQuestions, String advice) {
        this(card, commentCount, mentionChips, similarClosed, proposal, waiting, blockedBy, openQuestions, advice, null);
    }

    /**
     * {@code openQuestions}: Claude's questions on the card still waiting on the user (specs/019) - the ❓ on the tile;
     * {@code advice}: the option Claude recommends in the first of them (specs/020), "✦ advises: To do".
     */
    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal,
                       WaitingOn waiting, List<CardRef> blockedBy, int openQuestions) {
        this(card, commentCount, mentionChips, similarClosed, proposal, waiting, blockedBy, openQuestions, null);
    }

    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal,
                       WaitingOn waiting, List<CardRef> blockedBy) {
        this(card, commentCount, mentionChips, similarClosed, proposal, waiting, blockedBy, 0);
    }

    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal,
                       WaitingOn waiting) {
        this(card, commentCount, mentionChips, similarClosed, proposal, waiting, null);
    }

    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed) {
        this(card, commentCount, mentionChips, similarClosed, null, null, null);
    }

    public CardSummary(Card card, int commentCount, List<MentionRef> mentionChips, SimilarClosed similarClosed, Proposal proposal) {
        this(card, commentCount, mentionChips, similarClosed, proposal, null, null);
    }

    public CardSummary {
        mentionChips = mentionChips == null ? List.of() : List.copyOf(mentionChips);
        blockedBy = blockedBy == null ? List.of() : List.copyOf(blockedBy);
    }
}
