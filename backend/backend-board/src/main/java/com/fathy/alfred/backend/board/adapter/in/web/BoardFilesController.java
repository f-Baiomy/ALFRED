package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.WidgetsUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

/**
 * Files on cards and cycles (specs/017 R36) and a project's widgets (R34). Under /board, so the board's edit access
 * applies to every write. A file is always served as a download in a sandbox (never rendered by the browser as a page).
 */
@RestController
public class BoardFilesController {

    public record WidgetRequest(String kind, String info, String source) {
    }

    private final BoardFilesUseCase files;
    private final WidgetsUseCase widgets;

    public BoardFilesController(BoardFilesUseCase files, WidgetsUseCase widgets) {
        this.files = files;
        this.widgets = widgets;
    }

    /** The body is the file's bytes as they are; its name (and so its type) is {@code name}. */
    @PostMapping("/board/files")
    public ResponseEntity<?> attach(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor,
                                    @RequestParam(required = false) String card, @RequestParam(required = false) String cycle,
                                    @RequestParam(required = false) String project, @RequestParam String name,
                                    @RequestBody(required = false) byte[] data) {
        return respond(files.attach(BoardWeb.actor(actor), card, cycle, project, name, data), HttpStatus.CREATED);
    }

    @GetMapping("/board/files")
    public ResponseEntity<?> list(@RequestParam(required = false) String card, @RequestParam(required = false) String cycle) {
        return respond(files.files(card, cycle), HttpStatus.OK);
    }

    /** The bytes, as a download; {@code ?inline=true} for a text file read by a snippet or Claude (still plain text, sandboxed). */
    @GetMapping("/board/files/{id}")
    public ResponseEntity<byte[]> file(@PathVariable String id, @RequestParam(defaultValue = "false") boolean inline) {
        return files.file(id).map(f -> {
            boolean text = inline && f.isText();
            // an answers file (specs/037 D19) is bytes to save, whatever the request asks - never a page
            MediaType type = f.isAnswersFile() ? MediaType.APPLICATION_OCTET_STREAM
                    : text ? new MediaType("text", "plain", StandardCharsets.UTF_8) : MediaType.parseMediaType(f.mime());
            return ResponseEntity.ok()
                    .contentType(type)
                    .header("Content-Disposition", (text ? ContentDisposition.inline() : ContentDisposition.attachment())
                            .filename(f.name(), StandardCharsets.UTF_8).build().toString())
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Security-Policy", "sandbox; default-src 'none'")
                    .cacheControl(CacheControl.noCache())
                    .body(f.data());
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/board/files/{id}")
    public ResponseEntity<?> remove(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id) {
        return respond(files.remove(BoardWeb.actor(actor), id), HttpStatus.NO_CONTENT);
    }

    // ---------------------------------------------------------------------------------------------------------- widgets

    @GetMapping("/board/widgets")
    public ResponseEntity<?> widgets(@RequestParam(defaultValue = "") String project) {
        return respond(widgets.widgets(project), HttpStatus.OK);
    }

    @GetMapping("/board/widgets/{name}")
    public ResponseEntity<?> widget(@PathVariable String name, @RequestParam(defaultValue = "") String project) {
        return widgets.widget(project, name).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No widget \"" + name + "\" in this project"));
    }

    @PutMapping("/board/widgets/{name}")
    public ResponseEntity<?> putWidget(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String name,
                                       @RequestParam(defaultValue = "") String project, @RequestBody WidgetRequest body) {
        return respond(widgets.put(BoardWeb.actor(actor), project, name, body.kind(), body.info(), body.source()), HttpStatus.OK);
    }

    @DeleteMapping("/board/widgets/{name}")
    public ResponseEntity<?> deleteWidget(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String name,
                                          @RequestParam(defaultValue = "") String project) {
        return respond(widgets.delete(BoardWeb.actor(actor), project, name), HttpStatus.NO_CONTENT);
    }

    private static ResponseEntity<?> respond(Result<?> r, HttpStatus ok) {
        if (!r.isOk()) {
            return BoardWeb.refused(r.outcome(), r.message());
        }
        return ok == HttpStatus.NO_CONTENT || r.value() == null ? ResponseEntity.noContent().build() : ResponseEntity.status(ok).body(r.value());
    }
}
