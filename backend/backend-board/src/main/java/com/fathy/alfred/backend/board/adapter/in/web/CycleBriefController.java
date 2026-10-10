package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.BriefRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.MarkRequestDto;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.MultipartHttpServletRequest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * A session cycle's brief, spec files and acceptance checklist (contracts/rest-api.md). A spec file arrives as a raw
 * text body or as a multipart {@code file}; at most 5 MB is ever read, so an oversized upload is refused without
 * being held in memory whole.
 */
@RestController
public class CycleBriefController {

    private static final String ACTOR = BoardWeb.ACTOR_HEADER;

    private final ManageBriefUseCase briefs;
    private final ManageSpecFilesUseCase specs;
    private final MarkChecklistUseCase checklist;

    public CycleBriefController(ManageBriefUseCase briefs, ManageSpecFilesUseCase specs, MarkChecklistUseCase checklist) {
        this.briefs = briefs;
        this.specs = specs;
        this.checklist = checklist;
    }

    @GetMapping("/board/cycles/{cycleId}/brief")
    public ResponseEntity<?> brief(@PathVariable String cycleId) {
        return ResponseEntity.ok(briefs.brief(cycleId));
    }

    @PutMapping("/board/cycles/{cycleId}/brief")
    public ResponseEntity<?> putBrief(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                      @Valid @RequestBody BriefRequestDto body) {
        ManageBriefUseCase.BriefOutcome outcome = briefs.putBrief(BoardWeb.actor(actor), cycleId, body.text());
        return outcome.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(outcome.brief())
                : BoardWeb.refused(outcome.outcome(), outcome.message());
    }

    @GetMapping("/board/cycles/{cycleId}/specs")
    public ResponseEntity<?> specs(@PathVariable String cycleId) {
        return ResponseEntity.ok(specs.specs(cycleId));
    }

    @GetMapping("/board/cycles/{cycleId}/specs/{name:.+}")
    public ResponseEntity<?> spec(@PathVariable String cycleId, @PathVariable String name) {
        return specs.spec(cycleId, name).<ResponseEntity<?>>map(f -> ResponseEntity.ok()
                        .contentType(new MediaType("text", "plain", StandardCharsets.UTF_8))
                        .header(HttpHeaders.CONTENT_DISPOSITION, "inline")
                        .body(f.content()))
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No spec file " + name));
    }

    @PutMapping("/board/cycles/{cycleId}/specs/{name:.+}")
    public ResponseEntity<?> putSpec(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                     @PathVariable String name, HttpServletRequest request) throws IOException {
        String content;
        if (request instanceof MultipartHttpServletRequest multipart) {
            MultipartFile file = multipart.getFile("file");
            if (file == null) {
                return BoardWeb.refused(CardChange.Outcome.INVALID, "The upload has no 'file' part");
            }
            try (InputStream in = file.getInputStream()) {
                content = readCapped(in);
            }
        } else {
            try (InputStream in = request.getInputStream()) {
                content = readCapped(in);
            }
        }
        if (content == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "A spec file can be at most 5 MB");
        }
        ManageSpecFilesUseCase.SpecOutcome outcome = specs.put(BoardWeb.actor(actor), cycleId, name, content);
        if (outcome.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(outcome.outcome(), outcome.message());
        }
        return ResponseEntity.ok(Map.of("name", outcome.file().name(), "size", outcome.file().size(),
                "uploadedAt", outcome.file().uploadedAt().toString(), "replaced", outcome.replaced()));
    }

    @DeleteMapping("/board/cycles/{cycleId}/specs/{name:.+}")
    public ResponseEntity<?> deleteSpec(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                        @PathVariable String name) {
        CardChange.Outcome outcome = specs.delete(BoardWeb.actor(actor), cycleId, name);
        return outcome == CardChange.Outcome.OK ? ResponseEntity.noContent().build()
                : BoardWeb.refused(outcome, outcome == CardChange.Outcome.NOT_FOUND ? "No spec file " + name : "Only the user deletes spec files");
    }

    @GetMapping("/board/cycles/{cycleId}/checklist")
    public ResponseEntity<?> checklist(@PathVariable String cycleId) {
        return ResponseEntity.ok(checklist.checklist(cycleId));
    }

    @PutMapping("/board/cycles/{cycleId}/checklist/{fileName}/{itemKey}")
    public ResponseEntity<?> mark(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                  @PathVariable String fileName, @PathVariable String itemKey, @Valid @RequestBody MarkRequestDto body) {
        MarkChecklistUseCase.MarkOutcome outcome = checklist.mark(BoardWeb.actor(actor), cycleId, fileName, itemKey, body.mark(),
                body.evidence());
        return outcome.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(outcome.item())
                : BoardWeb.refused(outcome.outcome(), outcome.message());
    }

    /** The text, or null when it is larger than the spec limit - never reads past it. */
    static String readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > ManageSpecFilesUseCase.MAX_BYTES) {
                return null;
            }
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8);
    }
}
