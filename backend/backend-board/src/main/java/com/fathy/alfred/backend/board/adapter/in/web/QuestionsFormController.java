package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.AnswersImportUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuestionsFormUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The questions form and its answers file (specs/037, docs/board.md "Questions form"). Building a form stores it, so it is
 * a board write (edit access, the board's holder); a dry-run import reads only; applying is the user's - for Claude
 * only with {@code askedIn}. The answers file itself is uploaded through POST /board/files and always served as a download.
 */
@RestController
public class QuestionsFormController {

    public record FormRequest(List<Integer> cards, String lang, String title, String format) {
    }

    /** One of {@code fileId} (a stored file), {@code text} (the whole html), {@code answers} (the machine block's JSON). */
    public record ImportRequest(String fileId, String text, JsonNode answers, Boolean dryRun, String askedIn) {
    }

    private final QuestionsFormUseCase form;
    private final AnswersImportUseCase imports;

    public QuestionsFormController(QuestionsFormUseCase form, AnswersImportUseCase imports) {
        this.form = form;
        this.imports = imports;
    }

    @PostMapping("/board/boards/{id}/questions-form")
    public ResponseEntity<?> build(@PathVariable String id, @RequestBody(required = false) FormRequest body) {
        FormRequest r = body == null ? new FormRequest(null, null, null, null) : body;
        String format = r.format() == null ? "html" : r.format().strip().toLowerCase(java.util.Locale.ROOT);
        if (!format.equals("html") && !format.equals("zip")) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "format is html or zip");
        }
        Result<QuestionsFormUseCase.Built> out = form.build(new QuestionsFormUseCase.Request(id, r.cards(), r.lang(), r.title(), format.equals("zip")));
        if (!out.isOk()) {
            return BoardWeb.refused(out.outcome(), out.message());
        }
        QuestionsFormUseCase.Built b = out.value();
        ResponseEntity.BodyBuilder res = ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(b.contentType()))
                .header("Content-Disposition", ContentDisposition.attachment().filename(b.fileName(), StandardCharsets.UTF_8).build().toString())
                .header("X-Content-Type-Options", "nosniff")
                .header("X-Alfred-Form-Id", b.formId())
                .header("X-Alfred-Form-Questions", Integer.toString(b.questions()))
                .header("X-Alfred-Form-Cards", b.cards().stream().map(String::valueOf).reduce((x, y) -> x + "," + y).orElse(""))
                .header("X-Alfred-Form-Size", Long.toString(b.htmlBytes()))
                .header("X-Alfred-Form-Name", URLEncoder.encode(b.fileName(), StandardCharsets.UTF_8))
                .header("Access-Control-Expose-Headers", "Content-Disposition, X-Alfred-Form-Id, X-Alfred-Form-Questions, X-Alfred-Form-Cards, "
                        + "X-Alfred-Form-Size, X-Alfred-Form-Name, X-Alfred-Form-Left-Out, X-Alfred-Form-Warning")
                .cacheControl(CacheControl.noStore());
        if (!b.leftOut().isEmpty()) {
            res.header("X-Alfred-Form-Left-Out", URLEncoder.encode(String.join("\n", b.leftOut()), StandardCharsets.UTF_8));
        }
        if (b.warning() != null) {
            res.header("X-Alfred-Form-Warning", URLEncoder.encode(b.warning(), StandardCharsets.UTF_8));
        }
        return res.body(b.bytes());
    }

    @PostMapping("/board/boards/{id}/answers-import")
    public ResponseEntity<?> importAnswers(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                           @RequestBody(required = false) ImportRequest body) {
        if (body == null) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "Send fileId, text or answers");
        }
        boolean dryRun = body.dryRun() == null || body.dryRun();
        int given = (body.fileId() != null ? 1 : 0) + (body.text() != null ? 1 : 0) + (body.answers() != null && !body.answers().isNull() ? 1 : 0);
        if (given != 1) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "Send one of fileId, text or answers");
        }
        Result<AnswersImportUseCase.Report> out;
        if (body.fileId() != null) {
            out = imports.fromStoredFile(id, body.fileId(), dryRun, BoardWeb.actor(actor), body.askedIn());
        } else if (body.text() != null) {
            out = imports.fromFile(id, "answers.html", body.text().getBytes(StandardCharsets.UTF_8), dryRun, BoardWeb.actor(actor), body.askedIn());
        } else {
            String json = body.answers().isTextual() ? body.answers().asText() : body.answers().toString();
            out = imports.fromJson(id, json, dryRun, BoardWeb.actor(actor), body.askedIn());
        }
        return out.isOk() ? ResponseEntity.ok(out.value()) : BoardWeb.refused(out.outcome(), out.message());
    }

    /** The answers inside a stored answers file, checked against its form and board - read only, nothing applied. */
    @GetMapping("/board/files/{id}/answers.json")
    public ResponseEntity<?> answersOf(@PathVariable String id) {
        Result<AnswersImportUseCase.Report> out = imports.fromStoredFile(null, id, true, com.fathy.alfred.backend.board.domain.model.Actor.USER, null);
        return out.isOk() ? ResponseEntity.status(HttpStatus.OK).body(out.value()) : BoardWeb.refused(out.outcome(), out.message());
    }
}
