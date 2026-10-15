package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.EntryAnswers;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Question;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Claude's questions with options and the user's answers (specs/019): a question comment asks several questions, a
 * batch of answers is sent at once, some may stay open, an answer opens its follow-up, Claude withdraws with a reason,
 * Needs decision follows the open questions, the same question is not asked twice, and two Claude runs do not both
 * answer one message.
 */
class QuestionsTest {

    @TempDir
    Path dir;

    private BoardFixture f;
    private String card;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        card = f.add(Actor.USER, "p", CardKind.TASK, "Missing feature", "").card().id();
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private static final String ASK = """
            Which steps should I remove from the re-test plan?

            ```questions
            {"about": 1, "questions": [
              {"header": "Steps", "question": "Which steps should I remove from the re-test plan?", "why": "too long",
               "options": [{"label": "Only the extra filters", "then": "drop 7-11", "recommended": true}, {"label": "Keep all the steps"}]},
              {"header": "Checks", "question": "Which checks should the re-test run?", "multiSelect": true,
               "options": [{"label": "branchId is a list"}, {"label": "No ERROR log line"}, {"label": "At most 6 SQL"}]},
              {"header": "Merge", "question": "Should I merge #45 into #44?",
               "options": [{"label": "Yes"}, {"label": "No, keep both",
                            "followUp": {"header": "Plan", "question": "Which card keeps the steps?", "options": [{"label": "#44"}, {"label": "Both"}]}}]}
            ]}
            ```""";

    private long ask(String question) {
        var out = f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, null, question));
        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        return out.entry().id();
    }

    private Map<String, QuestionState> states() {
        Map<String, QuestionState> out = new java.util.LinkedHashMap<>();
        f.board.questions(card).forEach(q -> out.put(q.header(), q.state()));
        return out;
    }

    private static AnswerIn chose(String... options) {
        return new AnswerIn(List.of(options), null, null, null);
    }

    @Test
    void aQuestionCommentAsksEachOfItsQuestionsAndFollowUpsWaitForTheirAnswer() {
        ask(ASK);

        assertThat(states()).containsExactly(Map.entry("Steps", QuestionState.OPEN), Map.entry("Checks", QuestionState.OPEN),
                Map.entry("Merge", QuestionState.OPEN), Map.entry("Plan", QuestionState.PENDING));
        assertThat(f.board.get(card).orElseThrow().openQuestions()).isEqualTo(3);
        assertThat(f.board.get(card).orElseThrow().card().flags()).contains(Flag.NEEDS_DECISION);
        assertThat(f.board.query(new CardQuery("p", null, null, null, null, null, false, null, 0, 50)).cards().get(0).openQuestions()).isEqualTo(3);
    }

    @Test
    void someAnswersAreSentInOneBatchAndTheRestStayOpen() {
        long q = ask(ASK);

        var out = f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Steps", chose("Keep all the steps"),
                "Checks", new AnswerIn(List.of("branchId is a list", "No ERROR log line"), null, "keep step 5", null)))), true);

        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        assertThat(out.entries()).hasSize(1);
        ActivityEntry answer = out.entries().get(0);
        assertThat(answer.replyTo()).isEqualTo(q);
        assertThat(answer.text()).startsWith("**Answers** ").contains("Keep all the steps").contains("note: keep step 5").contains("```answers");
        assertThat(QuestionBlocks.answers(answer.text()).get("Checks").chose()).containsExactly("branchId is a list", "No ERROR log line");
        assertThat(states()).containsEntry("Steps", QuestionState.ANSWERED).containsEntry("Checks", QuestionState.ANSWERED)
                .containsEntry("Merge", QuestionState.OPEN);
        // one question still open: the card still waits on a decision
        assertThat(f.board.get(card).orElseThrow().card().flags()).contains(Flag.NEEDS_DECISION);

        f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Merge", chose("Yes")))), true);
        assertThat(states()).containsEntry("Merge", QuestionState.ANSWERED).containsEntry("Plan", QuestionState.DROPPED);
        assertThat(f.board.get(card).orElseThrow().card().flags()).doesNotContain(Flag.NEEDS_DECISION);
        assertThat(f.board.get(card).orElseThrow().openQuestions()).isZero();
    }

    @Test
    void anAnswerOpensItsFollowUpWhichMayBeAnsweredInTheSameSend() {
        long q = ask(ASK);

        f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Merge", chose("No, keep both")))), true);
        assertThat(states()).containsEntry("Plan", QuestionState.OPEN);

        long q2 = ask(ASK.replace("Which steps", "Which other steps").replace("Which checks", "Which other checks").replace("Should I merge", "Merge"));
        var both = f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q2, Map.of("Merge", chose("No, keep both"), "Plan", chose("#44")))), true);
        assertThat(both.outcome()).as(both.message()).isEqualTo(CardChange.Outcome.OK);
        assertThat(f.board.questions(card).stream().filter(x -> x.entryId() == q2 && x.header().equals("Plan")).findFirst().orElseThrow().state())
                .isEqualTo(QuestionState.ANSWERED);
        // a follow-up of an option not picked cannot be answered
        long q3 = ask(ASK.replace("Which steps", "Third steps").replace("Which checks", "Third checks").replace("Should I merge", "Third merge"));
        assertThat(f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q3, Map.of("Merge", chose("Yes"), "Plan", chose("#44")))), true).outcome())
                .isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void aBatchIsCheckedWholeBeforeAnythingIsWritten() {
        long q = ask(ASK);
        int before = f.store.activity(card, 0, 500).size();

        assertThat(f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Steps", chose("Keep all the steps"),
                "Checks", chose("not an option")))), true).outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Steps", chose("Only the extra filters", "Keep all the steps"))))
                , true).outcome()).as("one option only").isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of("Steps", new AnswerIn(List.of(), null, null, null)))), true)
                .outcome()).as("nothing picked").isEqualTo(CardChange.Outcome.INVALID);
        assertThat(f.board.answer(Actor.CLAUDE, card, List.of(new EntryAnswers(q, Map.of("Steps", chose("Keep all the steps")))), true).outcome())
                .isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(f.store.activity(card, 0, 500)).hasSize(before);
        assertThat(states().get("Steps")).isEqualTo(QuestionState.OPEN);
    }

    @Test
    void ownWordsAnswerAndLaterPutsAQuestionOffUntilItsTime() {
        long q = ask(ASK);

        var out = f.board.answer(Actor.USER, card, List.of(new EntryAnswers(q, Map.of(
                "Steps", new AnswerIn(List.of(), "Keep 1-6 and @[call:in:c1|POST /search]", null, null),
                "Checks", new AnswerIn(List.of(), null, null, Instant.parse("2026-10-10T10:00:00Z"))))), true);

        assertThat(out.outcome()).as(out.message()).isEqualTo(CardChange.Outcome.OK);
        assertThat(states()).containsEntry("Steps", QuestionState.ANSWERED).containsEntry("Checks", QuestionState.LATER);
        assertThat(f.board.get(card).orElseThrow().openQuestions()).as("Merge only").isEqualTo(1);
        f.clock.advanceSeconds(3700);
        assertThat(f.board.get(card).orElseThrow().openQuestions()).as("Checks is due again").isEqualTo(2);
    }

    @Test
    void claudeWithdrawsWithAReasonAndCannotClearTheFlagWhileAQuestionIsOpen() {
        long q = ask(ASK);

        var noReason = f.board.withdraw(Actor.CLAUDE, card, q, List.of("Merge"), " ");
        assertThat(noReason.outcome()).isEqualTo(CardChange.Outcome.INVALID);
        var clearFlag = f.board.update(Actor.CLAUDE, card, new UpdateCardUseCase.CardEdit(null, null, null, EnumSet.noneOf(Flag.class), null, null, null));
        assertThat(clearFlag.outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        assertThat(clearFlag.message()).contains("3 questions are still open").contains("board_withdraw_question");

        var w = f.board.withdraw(Actor.CLAUDE, card, q, List.of(), "your answer to [688] covers them");
        assertThat(w.outcome()).as(w.message()).isEqualTo(CardChange.Outcome.OK);
        assertThat(w.entry().text()).isEqualTo("**Withdrawn** Steps, Checks, Merge, Plan - your answer to [688] covers them");
        assertThat(states().values()).containsOnly(QuestionState.WITHDRAWN);
        assertThat(f.board.get(card).orElseThrow().card().flags()).doesNotContain(Flag.NEEDS_DECISION);
        assertThat(f.board.withdraw(Actor.USER, card, q, List.of(), "x").outcome()).isEqualTo(CardChange.Outcome.INVALID);
    }

    @Test
    void theSameQuestionAskedAgainWhileOpenIsNotAskedTwice() {
        long q = ask(ASK);
        int before = f.store.activity(card, 0, 500).size();

        var again = f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, null, ASK));

        assertThat(again.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(again.entry().id()).isEqualTo(q);
        assertThat(again.message()).contains("Already asked");
        assertThat(f.store.activity(card, 0, 500)).hasSize(before);
        // once answered, asking again is a new question
        f.board.withdraw(Actor.CLAUDE, card, q, List.of(), "re-asking");
        assertThat(f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, null, ASK)).entry().id())
                .isNotEqualTo(q);
    }

    @Test
    void aBadQuestionsBlockIsRefusedWithWhy() {
        var out = f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, null,
                "Which?\n\n```questions\n{\"questions\": [{\"header\": \"A\", \"question\": \"Which?\", \"options\": [{\"label\": \"only one\"}]}]}\n```"));
        assertThat(out.outcome()).isEqualTo(CardChange.Outcome.INVALID);
        assertThat(out.message()).contains("one option");
        assertThat(f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, null,
                "Which?\n\n```questions\n{not json\n```")).message()).contains("not valid JSON");
    }

    @Test
    void aPlainReplyStillAnswersEveryQuestionOfTheComment() {
        long q = ask(ASK);
        f.board.comment(Actor.USER, card, new CommentOnCardUseCase.Comment("keep everything, merge", null, null, null, null, null, null, q, true));
        assertThat(states()).containsEntry("Steps", QuestionState.ANSWERED).containsEntry("Merge", QuestionState.ANSWERED)
                .containsEntry("Plan", QuestionState.DROPPED);
        assertThat(f.board.get(card).orElseThrow().card().flags()).doesNotContain(Flag.NEEDS_DECISION);
    }

    @Test
    void questionsWrittenBeforeTheIndexAreIndexedWithWhatAnswersThem() {
        // what an older Alfred wrote: two plain questions, the first answered by a reply
        Instant at = f.clock.instant();
        long q1 = f.store.append(new ActivityEntry(0, card, Actor.CLAUDE, ActivityKind.COMMENT, "**Question** Stack vouchers?", null, null, at, null));
        long q2 = f.store.append(new ActivityEntry(0, card, Actor.CLAUDE, ActivityKind.COMMENT, "**Question** Name the branch?", null, null, at, null));
        f.store.append(new ActivityEntry(0, card, Actor.USER, ActivityKind.COMMENT, "No", null, null, at, q1));
        f.clock.advanceSeconds(120);

        List<Question> rows = f.board.questions(card);

        assertThat(rows).extracting(Question::entryId, Question::state).containsExactly(
                org.assertj.core.groups.Tuple.tuple(q1, QuestionState.ANSWERED), org.assertj.core.groups.Tuple.tuple(q2, QuestionState.OPEN));
        assertThat(rows.get(1).text()).isEqualTo("Name the branch?");
    }

    @Test
    void asecondClaudeReplyToTheSameMessageIsRefused() {
        long user = f.board.comment(Actor.USER, card, new CommentOnCardUseCase.Comment("why?", null, null, null, null)).entry().id();
        var first = f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, "because", null, user, false));
        assertThat(first.outcome()).isEqualTo(CardChange.Outcome.OK);

        var second = f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, "because, again", null, user, false));
        assertThat(second.outcome()).isEqualTo(CardChange.Outcome.CONFLICT);
        assertThat(second.message()).contains("Already answered");

        // the user's next message in the thread gets its own answer
        f.board.comment(Actor.USER, card, new CommentOnCardUseCase.Comment("and then?", null, null, null, null, null, null, user, false));
        assertThat(f.board.comment(Actor.CLAUDE, card, new CommentOnCardUseCase.Comment(null, null, null, null, null, "then this", null, user, false))
                .outcome()).isEqualTo(CardChange.Outcome.OK);
    }
}
