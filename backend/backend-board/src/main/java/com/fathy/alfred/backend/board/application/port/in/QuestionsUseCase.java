package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Question;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Claude's questions on a card and the user's answers (specs/019, docs/board.md "Questions"): every question with its
 * state, a batch of answers sent at once (each question comment gets one answer comment), and Claude withdrawing a
 * question with a reason. Needs decision follows the open questions.
 */
public interface QuestionsUseCase {

    /** One question's answer: the options picked, the user's own words, a note - or put off until {@code later}. */
    record AnswerIn(List<String> chose, String other, String note, Instant later) {

        public AnswerIn {
            chose = chose == null ? List.of() : List.copyOf(chose);
        }
    }

    /** The answers to the questions of one question comment, by header. */
    record EntryAnswers(long entryId, Map<String, AnswerIn> answers) {
    }

    record AnswersOutcome(CardChange.Outcome outcome, List<ActivityEntry> entries, String message) {
    }

    List<Question> questions(String cardId);

    /** Open questions per card of a project (or one cycle): the nav's count. */
    Map<String, Integer> openQuestionCards(String project, String cycleId);

    AnswersOutcome answer(Actor actor, String cardId, List<EntryAnswers> answers, boolean clearDecision);

    /** Claude takes back questions of a comment (all of its open ones when {@code headers} is empty) - with why. */
    CommentOnCardUseCase.CommentOutcome withdraw(Actor actor, String cardId, long entryId, List<String> headers, String reason);
}
