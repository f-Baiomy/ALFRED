package com.fathy.alfred.backend.board.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * One message of a board chat (specs/022, data-model.md). The text keeps mentions as {@code @[type:ref|label]} like a
 * comment does. {@code author} is the chat's own small set - not {@link Actor}, which older Alfreds read from card fields
 * and would throw on a new value.
 *
 * @param state     a user's message: WAITING → TAKEN → ANSWERED / STOPPED / CANCELLED; everything else DONE
 * @param coversTo  a SUMMARY: the last message id it covers (everything up to it folds under it, nothing is deleted)
 * @param replyTo   Claude's answer: the user message it answers
 * @param extra     proposals, questions, consent payloads, fix reports, visuals ... as Claude sent them
 */
public record ChatMessage(long id, ChatKey chat, Long parentId, Author author, Kind kind, String text, State state, boolean urgent,
                          boolean decision, String origin, List<String> context, String quote, JsonNode extra,
                          Map<String, Integer> reactions, Long coversTo, Long replyTo, String bridgeFrom, boolean superseded,
                          Instant createdAt, Instant editedAt) {

    /** The most text one message holds - the same as a card comment. */
    public static final int MAX_TEXT = 64 * 1024;

    public enum Author { USER, CLAUDE, ALFRED }

    public enum Kind { TEXT, SUMMARY, DIGEST, SYSTEM, TASK }

    public enum State { WAITING, TAKEN, ANSWERED, STOPPED, CANCELLED, DONE }

    public ChatMessage {
        text = text == null ? "" : text;
        if (text.length() > MAX_TEXT) {
            throw new IllegalArgumentException("A chat message holds at most " + MAX_TEXT + " characters");
        }
        context = context == null ? List.of() : List.copyOf(context);
        reactions = reactions == null ? Map.of() : Map.copyOf(reactions);
    }

    /** A user's message Claude has not answered yet - it can still be edited, cancelled or put first. */
    public boolean waiting() {
        return author == Author.USER && state == State.WAITING;
    }

    public ChatMessage withState(State next) {
        return new ChatMessage(id, chat, parentId, author, kind, text, next, urgent, decision, origin, context, quote, extra, reactions,
                coversTo, replyTo, bridgeFrom, superseded, createdAt, editedAt);
    }
}
