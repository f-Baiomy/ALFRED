package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.NewPage;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.PageEdit;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import org.springframework.http.CacheControl;
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

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pages, versions, saved state and shots (specs/017 R23, R28-R32). Under /board, so the board's edit access applies to
 * every write. A snippet id is a page's id, or an inline block's {@code inline:card:<id>:<where>:<n>} - the colons are
 * fine in a path segment.
 */
@RestController
public class SnippetsController {

    /** A new page; {@code owner} is card:<id>, cycle:<id> or project:<name>. */
    public record PageRequest(String owner, String project, String name, String kind, String info, String source) {
    }

    public record PageEditRequest(String name, String info, String source, Boolean pinned, Integer position, Integer baseVersion) {
    }

    /** {@code value}: any JSON; null removes the key. */
    public record StateRequest(JsonNode value) {
    }

    public record ShotRequest(Integer version, String png, List<String> console) {
    }

    private final SnippetsUseCase snippets;

    public SnippetsController(SnippetsUseCase snippets) {
        this.snippets = snippets;
    }

    @GetMapping("/board/pages")
    public ResponseEntity<?> pages(@RequestParam String owner, @RequestParam(required = false) String project) {
        return respond(snippets.pages(owner, project), HttpStatus.OK);
    }

    @PostMapping("/board/pages")
    public ResponseEntity<?> create(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @RequestBody PageRequest body) {
        return respond(snippets.create(BoardWeb.actor(actor), new NewPage(body.owner(), body.project(), body.name(), body.kind(), body.info(),
                body.source())), HttpStatus.CREATED);
    }

    @GetMapping("/board/snippets/{id}")
    public ResponseEntity<?> page(@PathVariable String id, @RequestParam(required = false) Integer version) {
        return snippets.page(id, version).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, version == null ? "No such page" : "No such version"));
    }

    @PutMapping("/board/snippets/{id}")
    public ResponseEntity<?> update(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                    @RequestBody PageEditRequest body) {
        return respond(snippets.update(BoardWeb.actor(actor), id, new PageEdit(body.name(), body.info(), body.source(), body.pinned(),
                body.position(), body.baseVersion())), HttpStatus.OK);
    }

    @DeleteMapping("/board/snippets/{id}")
    public ResponseEntity<?> delete(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id) {
        return respond(snippets.delete(BoardWeb.actor(actor), id), HttpStatus.NO_CONTENT);
    }

    @GetMapping("/board/snippets/{id}/versions")
    public ResponseEntity<?> versions(@PathVariable String id) {
        return respond(snippets.versions(id), HttpStatus.OK);
    }

    @GetMapping("/board/snippets/{id}/state")
    public ResponseEntity<?> state(@PathVariable String id) {
        return respond(snippets.state(id), HttpStatus.OK);
    }

    @GetMapping("/board/snippets/{id}/state/{key}")
    public ResponseEntity<?> stateValue(@PathVariable String id, @PathVariable String key) {
        return respond(snippets.state(id, key), HttpStatus.OK);
    }

    @PutMapping("/board/snippets/{id}/state/{key}")
    public ResponseEntity<?> putState(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                      @PathVariable String key, @RequestBody StateRequest body) {
        JsonNode v = body == null ? null : body.value();
        return respond(snippets.putState(BoardWeb.actor(actor), id, key, v == null || v.isNull() ? null : v.toString()), HttpStatus.OK);
    }

    @GetMapping("/board/snippets/{id}/state/{key}/history")
    public ResponseEntity<?> stateHistory(@PathVariable String id, @PathVariable String key) {
        return respond(snippets.stateHistory(id, key), HttpStatus.OK);
    }

    @PostMapping("/board/snippets/{id}/shot")
    public ResponseEntity<?> putShot(@PathVariable String id, @RequestBody ShotRequest body) {
        return respond(snippets.putShot(id, body.version() == null ? 0 : body.version(), body.png(), body.console()), HttpStatus.NO_CONTENT);
    }

    /** The newest shot: version, console, when, and (unless {@code png=false}) the picture as a data: URL - what Claude's MCP tool reads. */
    @GetMapping("/board/snippets/{id}/shot")
    public ResponseEntity<?> shot(@PathVariable String id, @RequestParam(defaultValue = "true") boolean png) {
        return snippets.shot(id).<ResponseEntity<?>>map(s -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("snippetId", s.snippetId());
            out.put("version", s.version());
            out.put("at", s.at());
            out.put("console", s.console());
            if (png) {
                out.put("png", "data:image/png;base64," + Base64.getEncoder().encodeToString(s.png()));
            }
            return ResponseEntity.ok(out);
        }).orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No shot yet - open the snippet once and it draws one"));
    }

    @GetMapping("/board/snippets/{id}/shot.png")
    public ResponseEntity<byte[]> shotPng(@PathVariable String id) {
        return snippets.shot(id).map(SnippetShot::png).map(png -> ResponseEntity.ok().contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.noCache()).header("X-Content-Type-Options", "nosniff").body(png))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static ResponseEntity<?> respond(Result<?> r, HttpStatus ok) {
        if (!r.isOk()) {
            return BoardWeb.refused(r.outcome(), r.message());
        }
        return ok == HttpStatus.NO_CONTENT || r.value() == null ? ResponseEntity.noContent().build() : ResponseEntity.status(ok).body(r.value());
    }
}
