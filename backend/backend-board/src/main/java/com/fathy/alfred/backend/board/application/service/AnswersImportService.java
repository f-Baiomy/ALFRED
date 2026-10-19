package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.AnswersImportUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.EntryAnswers;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.QuestionFormStorePort;
import com.fathy.alfred.backend.board.domain.AnswersFile;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Question;
import com.fathy.alfred.backend.board.domain.model.QuestionForm;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Checks and applies an answers file (specs/037 D17-D18). Refused whole: a file that is not one, a form this Alfred did
 * not make, a form for another board. Then each answer by its ids: an unknown id; a question withdrawn, closed or
 * reworded since the form was made (its hash differs); a question answered on the board already (a file never
 * overwrites); "later"; nothing chosen. The rest are applied card by card through {@link QuestionsUseCase#answer}, as the
 * user, with the file named in each answer - exactly what answering on the board does, so the change feed and
 * alfred-live see an ordinary answer.
 */
@Service
public class AnswersImportService implements AnswersImportUseCase {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneOffset.UTC);

    private final QuestionFormStorePort forms;
    private final BoardStorePort store;
    private final BoardModelStorePort boards;
    private final BoardFileStorePort files;
    private final QuestionsUseCase questions;
    private final CommentOnCardUseCase comments;
    private final ObjectProvider<ManageBoardsUseCase> manage;
    private final Clock clock;

    @Autowired
    public AnswersImportService(QuestionFormStorePort forms, BoardStorePort store, BoardModelStorePort boards, BoardFileStorePort files,
                                QuestionsUseCase questions, CommentOnCardUseCase comments, ObjectProvider<ManageBoardsUseCase> manage) {
        this(forms, store, boards, files, questions, comments, manage, Clock.systemUTC());
    }

    AnswersImportService(QuestionFormStorePort forms, BoardStorePort store, BoardModelStorePort boards, BoardFileStorePort files,
                         QuestionsUseCase questions, CommentOnCardUseCase comments, ObjectProvider<ManageBoardsUseCase> manage, Clock clock) {
        this.forms = forms;
        this.store = store;
        this.boards = boards;
        this.files = files;
        this.questions = questions;
        this.comments = comments;
        this.manage = manage;
        this.clock = clock;
    }

    @Override
    public Result<Report> fromFile(String boardId, String name, byte[] data, boolean dryRun, Actor actor, String askedIn) {
        return run(boardId, AnswersFile.read(name, data), dryRun, actor, askedIn);
    }

    @Override
    public Result<Report> fromJson(String boardId, String json, boolean dryRun, Actor actor, String askedIn) {
        if (json == null || json.length() > AnswersFile.MAX_BYTES) {
            return Result.refused(Outcome.INVALID, json == null ? AnswersFile.NOT_ANSWERS : AnswersFile.TOO_BIG);
        }
        try {
            return run(boardId, AnswersFile.json(JSON.readTree(json)), dryRun, actor, askedIn);
        } catch (IOException e) {
            return Result.refused(Outcome.INVALID, AnswersFile.NOT_ANSWERS);
        }
    }

    @Override
    public Result<Report> fromStoredFile(String boardId, String fileId, boolean dryRun, Actor actor, String askedIn) {
        Optional<BoardFile> f = fileId == null || !fileId.matches("^[A-Za-z0-9-]{8,64}$") ? Optional.empty() : files.findFile(fileId);
        if (f.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such file");
        }
        return fromFile(boardId, f.get().name(), f.get().data(), dryRun, actor, askedIn);
    }

    private Result<Report> run(String boardId, AnswersFile.Read read, boolean dryRun, Actor actor, String askedIn) {
        if (!read.ok()) {
            return Result.refused(Outcome.INVALID, read.problem());
        }
        AnswersFile.Parsed file = read.parsed();
        Optional<QuestionForm> found = forms.findForm(file.formId());
        if (found.isEmpty()) {
            return Result.refused(Outcome.INVALID, "This answers file was not made by this Alfred - its questions form came from somewhere else");
        }
        QuestionForm form = found.get();
        if (boardId != null && !boardId.isBlank() && !form.boardId().equals(boardId.strip())) {
            String other = boards.board(form.boardId()).map(Board::name).orElse(form.boardId());
            return Result.refused(Outcome.INVALID, "This answers file belongs to another board: " + other);
        }
        if (!dryRun && actor == Actor.CLAUDE) {
            ManageBoardsUseCase m = manage.getIfAvailable();
            if (m == null || m.askedBy(askedIn).isEmpty()) {
                return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Applying answers is the user's - show the dry run, and when they say yes pass askedIn with "
                        + "their chat message id or \"terminal\"");
            }
        }
        Board board = boards.board(form.boardId()).orElse(null);
        Instant now = clock.instant();

        List<Row> rows = new ArrayList<>();
        // per card, per question comment: the answers to send together
        Map<String, Map<Long, Map<String, AnswerIn>>> toSend = new LinkedHashMap<>();
        Map<String, List<Integer>> rowsOfCard = new LinkedHashMap<>();
        List<int[]> laterRows = new ArrayList<>();
        String via = "answers file by " + (file.answeredBy().isBlank() ? "someone" : file.answeredBy())
                + (file.role().isBlank() ? "" : " (" + file.role() + ")") + (file.answeredAt() == null ? "" : ", " + WHEN.format(file.answeredAt()));

        for (AnswersFile.Answer a : file.answers()) {
            Optional<QuestionForm.Item> item = form.item(a.q());
            if (item.isEmpty()) {
                rows.add(new Row(a.q(), null, null, null, List.of(), a.other(), a.later(), a.note(), a.sure(), null, Verdict.UNKNOWN_KEY,
                        "No question " + a.q() + " in this form"));
                continue;
            }
            QuestionForm.Item it = item.get();
            List<Choice> chosen = new ArrayList<>();
            String unknown = null;
            for (String id : a.choice()) {
                Optional<QuestionForm.Option> o = it.options().stream().filter(x -> x.id().equals(id)).findFirst();
                if (o.isEmpty()) {
                    unknown = "No option " + id + " in question " + a.q();
                    break;
                }
                chosen.add(new Choice(id, o.get().label()));
            }
            if (unknown == null && !it.multiSelect() && chosen.size() > 1) {
                unknown = it.header() + " takes one option";
            }
            QuestionForm.FollowUp follow = null;
            List<Choice> followChosen = new ArrayList<>();
            if (unknown == null && a.follow() != null) {
                follow = it.followUps().stream().filter(f -> f.id().equals(a.follow().q())).findFirst().orElse(null);
                QuestionForm.FollowUp f = follow;
                if (f == null || a.choice().stream().noneMatch(f.optionId()::equals)) {
                    unknown = "No follow-up " + a.follow().q() + " under the options chosen";
                } else {
                    for (String id : a.follow().choice()) {
                        Optional<QuestionForm.Option> o = f.options().stream().filter(x -> x.id().equals(id)).findFirst();
                        if (o.isEmpty()) {
                            unknown = "No option " + id + " in follow-up " + f.id();
                            break;
                        }
                        followChosen.add(new Choice(id, o.get().label()));
                    }
                    if (followChosen.size() > 1) {
                        unknown = "A follow-up takes one option";
                    }
                }
            }
            String questionText = null;
            Optional<Card> card = store.find(it.cardId());
            Optional<Question> current = card.isEmpty() ? Optional.empty()
                    : store.questionsOf(it.cardId()).stream().filter(q -> q.entryId() == it.entryId() && q.header().equals(it.header())).findFirst();
            Optional<ActivityEntry> entry = current.isEmpty() ? Optional.empty() : store.activityEntry(it.entryId());
            if (current.isPresent()) {
                questionText = current.get().text();
            }
            FollowRow followRow = follow == null ? null : new FollowRow(follow.header(), null, followChosen);
            boolean free = it.options().isEmpty();
            boolean answered = !a.later() && (!chosen.isEmpty() || a.other() || (free && !a.note().isBlank()));
            Verdict v;
            String message = null;
            if (unknown != null) {
                v = Verdict.UNKNOWN_KEY;
                message = unknown;
            } else if (!answered && !a.later()) {
                v = Verdict.NOT_ANSWERED;
            } else if (card.isEmpty() || current.isEmpty() || entry.isEmpty() || card.get().status() == CardStatus.CLOSED
                    || current.get().state() == QuestionState.WITHDRAWN || current.get().state() == QuestionState.DROPPED
                    || !it.hash().equals(currentHash(entry.get(), current.get()))) {
                v = Verdict.CHANGED;
                message = "The question was withdrawn or changed since the form was made";
            } else if (current.get().state() == QuestionState.ANSWERED || !current.get().open(now) && current.get().state() != QuestionState.LATER) {
                v = Verdict.ALREADY_ANSWERED;
            } else if (a.later()) {
                v = Verdict.LATER;
            } else if (follow != null && !followChosen.isEmpty() && !followPending(it, follow)) {
                v = Verdict.CHANGED;
                message = "The follow-up was answered or changed since the form was made";
            } else {
                v = dryRun ? Verdict.APPLY : Verdict.APPLIED;
            }
            int index = rows.size();
            rows.add(new Row(a.q(), it.cardNumber(), it.header(), questionText, chosen, a.other(), a.later(), a.note(), a.sure(), followRow, v, message));
            if (v == Verdict.APPLIED) {
                String note = a.note().isBlank() ? null : a.note();
                String other = a.other() || free ? (note == null ? "(no text)" : note) : null;
                Map<String, AnswerIn> byHeader = toSend.computeIfAbsent(it.cardId(), k -> new LinkedHashMap<>())
                        .computeIfAbsent(it.entryId(), k -> new LinkedHashMap<>());
                byHeader.put(it.header(), new AnswerIn(chosen.stream().map(Choice::label).toList(), other, other != null ? null : note, null, via, a.sure()));
                if (follow != null && !followChosen.isEmpty()) {
                    byHeader.put(follow.header(), new AnswerIn(followChosen.stream().map(Choice::label).toList(), null, null, null, via, a.sure()));
                }
                rowsOfCard.computeIfAbsent(it.cardId(), k -> new ArrayList<>()).add(index);
            } else if (v == Verdict.LATER && !dryRun) {
                laterRows.add(new int[]{index});
            }
        }

        int applied = 0;
        if (!dryRun) {
            for (Map.Entry<String, Map<Long, Map<String, AnswerIn>>> c : toSend.entrySet()) {
                List<EntryAnswers> batch = c.getValue().entrySet().stream().map(e -> new EntryAnswers(e.getKey(), e.getValue())).toList();
                // as the board's answer dialog does: once nothing is open, Needs decision goes
                QuestionsUseCase.AnswersOutcome out = questions.answer(Actor.USER, c.getKey(), batch, true);
                List<Integer> idx = rowsOfCard.get(c.getKey());
                if (out.outcome() == Outcome.OK) {
                    applied += idx.size();
                } else {
                    for (int i : idx) {
                        Row r = rows.get(i);
                        rows.set(i, new Row(r.q(), r.card(), r.header(), r.question(), r.choice(), r.other(), r.later(), r.note(), r.sure(), r.follow(),
                                Verdict.REFUSED, out.message()));
                    }
                }
            }
            for (int[] l : laterRows) {
                Row r = rows.get(l[0]);
                QuestionForm.Item it = form.item(r.q()).orElseThrow();
                String who = file.answeredBy().isBlank() ? "Someone" : file.answeredBy();
                String text = "**Later** " + it.header() + " - " + who + " will answer later" + (r.note() == null || r.note().isBlank() ? "" : ": " + r.note())
                        + " (from the " + via + ")";
                comments.comment(Actor.USER, it.cardId(), new CommentOnCardUseCase.Comment(text, null, null, null, null, null, null));
            }
        }
        Map<Verdict, Integer> summary = new EnumMap<>(Verdict.class);
        rows.forEach(r -> summary.merge(r.result(), 1, Integer::sum));
        FileInfo info = new FileInfo(file.formId(), form.boardId(), board == null ? null : board.name(), file.answeredBy(), file.role(),
                file.answeredAt() == null ? null : file.answeredAt().toString(), file.lang());
        return Result.ok(new Report(info, List.copyOf(rows), applied, summary, dryRun));
    }

    /** The follow-up still waits for its parent's answer (it is answered with it). */
    private boolean followPending(QuestionForm.Item it, QuestionForm.FollowUp follow) {
        return store.questionsOf(it.cardId()).stream()
                .anyMatch(q -> q.entryId() == it.entryId() && q.header().equals(follow.header()) && q.state() == QuestionState.PENDING);
    }

    /** The question's hash as the board has it now - the form's hash of a question that was not reworded. */
    static String currentHash(ActivityEntry entry, Question q) {
        Optional<JsonNode> block = QuestionBlocks.questionsBlock(entry.text());
        JsonNode node = block.map(b -> b.path("questions").path(q.idx())).orElse(null);
        if (node == null || !node.isObject()) {
            return QuestionsFormService.hash(q.text(), List.of());
        }
        List<String> labels = new ArrayList<>();
        node.path("options").forEach(o -> labels.add(o.path("label").asText("")));
        return QuestionsFormService.hash(node.path("question").asText(q.text()), labels);
    }
}
