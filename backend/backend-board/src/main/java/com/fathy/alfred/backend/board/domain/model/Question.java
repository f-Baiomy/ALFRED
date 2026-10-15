package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * One question of Claude's on a card (specs/019): a question comment holds one or more (its ```questions block), each
 * by its {@code header}. The comment's text is the source of truth; this is its index, kept as answers arrive.
 * A follow-up names the question and option that open it ({@code parentIdx}, {@code parentOption}) and stays PENDING
 * until that question is answered: OPEN when that option was picked, DROPPED when another one was.
 * {@code laterUntil}: a question the user put off counts as open again after that time. {@code recommended}: the label of
 * the option Claude advises, shown on the card (specs/020).
 */
public record Question(long entryId, String cardId, int idx, String header, String text, QuestionState state, Instant laterUntil,
                       Long answerEntry, Integer parentIdx, String parentOption, Instant askedAt, String recommended) {

    public Question(long entryId, String cardId, int idx, String header, String text, QuestionState state, Instant laterUntil,
                    Long answerEntry, Integer parentIdx, String parentOption, Instant askedAt) {
        this(entryId, cardId, idx, header, text, state, laterUntil, answerEntry, parentIdx, parentOption, askedAt, null);
    }

    /** Waiting on the user now. */
    public boolean open(Instant now) {
        return state == QuestionState.OPEN || (state == QuestionState.LATER && laterUntil != null && !laterUntil.isAfter(now));
    }

    public Question with(QuestionState next, Instant later, Long answer) {
        return new Question(entryId, cardId, idx, header, text, next, later, answer, parentIdx, parentOption, askedAt, recommended);
    }
}
