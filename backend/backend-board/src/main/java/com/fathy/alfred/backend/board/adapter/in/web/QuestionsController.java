package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Claude's questions and the user's answers (specs/019, docs/board.md "Questions"). Under /board: the board's edit
 * access applies to the writes.
 */
@RestController
public class QuestionsController {

    /** One question's answer: options picked, own words, a note, or "later" (an ISO instant). */
    public record AnswerDto(List<String> chose, String other, String note, String later) {
    }

    /** The answers to one question comment, by header. */
    public record EntryAnswersDto(long entry, Map<String, AnswerDto> answers) {
    }

    public record AnswersRequest(List<EntryAnswersDto> answers, Boolean clearDecision) {
    }

    public record WithdrawRequest(List<String> headers, String reason) {
    }

    private final QuestionsUseCase questions;

    public QuestionsController(QuestionsUseCase questions) {
        this.questions = questions;
    }

    @GetMapping("/board/cards/{id}/questions")
    public ResponseEntity<?> list(@PathVariable String id) {
        return ResponseEntity.ok(questions.questions(id));
    }

    /** Cards with open questions and how many: the nav's count (project "" is No project). */
    @GetMapping("/board/questions")
    public ResponseEntity<?> open(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String cycleId) {
        Map<String, Integer> cards = questions.openQuestionCards(project, cycleId);
        return ResponseEntity.ok(Map.of("cards", cards, "total", cards.values().stream().mapToInt(Integer::intValue).sum()));
    }

    @PostMapping("/board/cards/{id}/answers")
    public ResponseEntity<?> answer(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                    @RequestBody AnswersRequest body) {
        List<QuestionsUseCase.EntryAnswers> answers = new ArrayList<>();
        try {
            for (EntryAnswersDto e : body.answers() == null ? List.<EntryAnswersDto>of() : body.answers()) {
                Map<String, QuestionsUseCase.AnswerIn> byHeader = new LinkedHashMap<>();
                (e.answers() == null ? Map.<String, AnswerDto>of() : e.answers()).forEach((header, a) -> byHeader.put(header,
                        new QuestionsUseCase.AnswerIn(a.chose(), blankToNull(a.other()), blankToNull(a.note()),
                                blankToNull(a.later()) == null ? null : Instant.parse(a.later()))));
                answers.add(new QuestionsUseCase.EntryAnswers(e.entry(), byHeader));
            }
        } catch (DateTimeParseException ex) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "later must be a time (ISO-8601)");
        }
        QuestionsUseCase.AnswersOutcome out = questions.answer(BoardWeb.actor(actor), id, answers, !Boolean.FALSE.equals(body.clearDecision()));
        if (out.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(out.outcome(), out.message());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("entries", out.entries()));
    }

    @PostMapping("/board/cards/{id}/questions/{entry}/withdraw")
    public ResponseEntity<?> withdraw(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                      @PathVariable long entry, @RequestBody WithdrawRequest body) {
        CommentOnCardUseCase.CommentOutcome out = questions.withdraw(BoardWeb.actor(actor), id, entry, body.headers(), body.reason());
        if (out.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(out.outcome(), out.message());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(out.entry());
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
