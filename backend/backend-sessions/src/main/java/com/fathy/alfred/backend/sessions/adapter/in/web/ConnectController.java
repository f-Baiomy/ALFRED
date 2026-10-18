package com.fathy.alfred.backend.sessions.adapter.in.web;

import com.fathy.alfred.backend.sessions.application.port.in.ConnectUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * "Connect this PC" (specs/031, docs/server.md "The helper"): the browser asks for a connect file (its text comes back in
 * the answer, so the one-time token is never in a URL), the user runs it, and the browser collects its key once the PC's
 * helper registered with that token - told by the /ws/sessions signal, never a poll. The helper, the skills and node.exe
 * are public: nothing in them is secret.
 */
@RestController
public class ConnectController {

    private final KeysUseCase keys;
    private final ConnectUseCase connect;

    public ConnectController(KeysUseCase keys, ConnectUseCase connect) {
        this.keys = keys;
        this.connect = connect;
    }

    @PostMapping("/board/connect")
    public ResponseEntity<?> start(@Valid @RequestBody StartDto body, HttpServletRequest request) {
        try {
            // a browser that is already someone's connects the PC as that person (another Claude account, another Windows user)
            String owner = keys.authenticate(request.getHeader(Keys.HEADER)).map(Caller::user).orElse(null);
            KeysUseCase.ConnectStart s = keys.connectStart(body.label(), owner);
            ConnectUseCase.Script script = connect.script(body.server(), s.token(), body.os());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("connectId", s.connectId());
            out.put("collectSecret", s.collectSecret());
            out.put("expiresAt", s.expiresAt());
            out.put("as", owner);
            out.put("fileName", script.fileName());
            out.put("script", script.text());
            out.put("run", script.run());
            out.put("versions", connect.versions());
            return ResponseEntity.status(HttpStatus.CREATED).body(out);
        } catch (IllegalArgumentException e) {
            return SessionsController.refused(HttpStatus.BAD_REQUEST, "INVALID", e.getMessage());
        } catch (IllegalStateException e) {
            return SessionsController.refused(HttpStatus.TOO_MANY_REQUESTS, "BUSY", e.getMessage());
        }
    }

    @PostMapping("/board/connect/collect")
    public ResponseEntity<?> collect(@Valid @RequestBody CollectDto body) {
        return keys.collect(body.connectId(), body.collectSecret()).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> SessionsController.refused(HttpStatus.NOT_FOUND, "NOT_YET", "The PC has not connected yet"));
    }

    @GetMapping("/board/connect/versions")
    public ConnectUseCase.Versions versions() {
        return connect.versions();
    }

    @GetMapping(value = "/board/connect/alfred-helper.mjs", produces = "text/javascript;charset=UTF-8")
    public ResponseEntity<String> helper() {
        return connect.helperScript().map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/board/connect/skills")
    public ResponseEntity<?> skills() {
        return connect.skills().<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/board/connect/node.exe")
    public ResponseEntity<?> node() {
        return connect.nodeExe().<ResponseEntity<?>>map(p -> ResponseEntity.ok()
                        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=node.exe")
                        .contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(p)))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    public record StartDto(@Size(max = 300) String server, @Size(max = 20) String os, @Size(max = 200) String label) {
    }

    public record CollectDto(@Size(max = 40) String connectId, @Size(max = 100) String collectSecret) {
    }
}
