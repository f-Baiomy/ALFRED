package com.fathy.alfred.backend.sessions.adapter.in.web;

import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.SessionsUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.UserSettingsUseCase;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.net.InetAddress;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Board sessions (specs/031, docs/board.md "Board sessions"): keys and pairing, the board lock, the boards' Claude sessions,
 * the commands a user queues for their own PCs, My settings and the board audit. Callers name themselves with
 * {@code X-Alfred-Key}. Writes also pass the board's edit rule (BoardEditAccessInterceptor) like every /board write, so the
 * tunnel stays read-only. The lock itself is applied to the other /board writes by backend-app/boardbridge.
 */
@RestController
public class SessionsController {

    static final int MAX_WAIT_SECONDS = 50;

    private final KeysUseCase keys;
    private final HoldersUseCase holders;
    private final SessionsUseCase sessions;
    private final UserSettingsUseCase settings;
    private final ObjectProvider<AdminRequestCheck> adminCheck;

    public SessionsController(KeysUseCase keys, HoldersUseCase holders, SessionsUseCase sessions, UserSettingsUseCase settings,
                              ObjectProvider<AdminRequestCheck> adminCheck) {
        this.keys = keys;
        this.holders = holders;
        this.sessions = sessions;
        this.settings = settings;
        this.adminCheck = adminCheck;
    }

    // ---- who is who

    @PostMapping("/board/helpers/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterDto body, HttpServletRequest request) {
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(keys.registerHelper(body.user(), body.machine(), body.claudeAccount(),
                    request.getRemoteAddr()));
        } catch (IllegalArgumentException e) {
            return refused(HttpStatus.BAD_REQUEST, "INVALID", e.getMessage());
        }
    }

    @PutMapping("/board/helpers/heartbeat")
    public ResponseEntity<?> heartbeat(@RequestBody(required = false) Map<String, Object> info, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty() || !c.get().isHelper()) {
            return unknown();
        }
        try {
            String json = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(info == null ? Map.of() : info);
            return ResponseEntity.ok(helperView(keys.heartbeat(c.get(), request.getRemoteAddr(), json), true));
        } catch (IllegalArgumentException | com.fasterxml.jackson.core.JsonProcessingException e) {
            return refused(HttpStatus.BAD_REQUEST, "INVALID", e.getMessage());
        }
    }

    @PostMapping("/board/helpers/pair-code")
    public ResponseEntity<?> pairCode(HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty() || !c.get().isHelper()) {
            return unknown();
        }
        return ResponseEntity.ok(keys.pairCode(c.get()));
    }

    @PostMapping("/board/browsers/pair")
    public ResponseEntity<?> pair(@Valid @RequestBody PairDto body) {
        return keys.pairBrowser(body.code(), body.label()).<ResponseEntity<?>>map(i -> ResponseEntity.status(HttpStatus.CREATED).body(i))
                .orElseGet(() -> refused(HttpStatus.FORBIDDEN, "WRONG_CODE", "That code is wrong, used or expired - ask your helper for a new one"));
    }

    /** Who this browser or helper is; {@code {"user": null}} for an unpaired one. */
    @GetMapping("/board/me")
    public ResponseEntity<?> me(HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("user", c.map(Caller::user).orElse(null));
        out.put("machine", c.map(Caller::machine).orElse(null));
        out.put("kind", c.map(x -> x.kind().name()).orElse(null));
        out.put("keyId", c.map(Caller::keyId).orElse(null));
        out.put("helperKeyId", c.map(Caller::helperKeyId).orElse(null));
        out.put("admin", admin(request));
        return ResponseEntity.ok(out);
    }

    @GetMapping("/board/me/devices")
    public ResponseEntity<?> devices(HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        KeysUseCase.Devices d = keys.devices(c.get());
        Instant now = Instant.now();
        return ResponseEntity.ok(Map.of(
                "helpers", d.helpers().stream().filter(h -> h.revokedAt() == null).map(h -> helperView(h, true)).toList(),
                "browsers", d.browsers().stream().filter(b -> b.revokedAt() == null).map(b -> Map.of("keyId", b.keyId(), "label", nz(b.label()),
                        "pairedAt", b.pairedAt(), "lastSeen", b.lastSeen() == null ? now : b.lastSeen(), "thisOne", b.keyId().equals(c.get().keyId())))
                        .toList()));
    }

    @DeleteMapping("/board/me/devices/{keyId}")
    public ResponseEntity<?> revokeOwn(@PathVariable String keyId, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        return keys.revokeOwn(c.get(), keyId) ? ResponseEntity.noContent().build()
                : refused(HttpStatus.NOT_FOUND, "NOT_FOUND", "Not one of your keys");
    }

    @GetMapping(value = "/board/me/settings", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> mySettings(HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(settings.get(c.get()));
    }

    @PutMapping(value = "/board/me/settings", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> putMySettings(@RequestBody String body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        return settings.put(c.get(), body).<ResponseEntity<?>>map(s -> ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(s))
                .orElseGet(() -> refused(HttpStatus.BAD_REQUEST, "INVALID",
                        "Settings are one JSON object up to 64 KB, with no token or password in them - the Azure token stays on your PC"));
    }

    /** The caller's own PCs, to pick where a session starts. */
    @GetMapping("/board/me/helpers")
    public ResponseEntity<?> myHelpers(HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        return ResponseEntity.ok(keys.helpersOf(c.get().user()).stream().map(h -> helperView(h, true)).toList());
    }

    @GetMapping("/board/users")
    public ResponseEntity<?> users(HttpServletRequest request) {
        return admin(request) ? ResponseEntity.ok(keys.users()) : notAdmin();
    }

    @GetMapping("/board/users/{user}/helpers")
    public ResponseEntity<?> userHelpers(@PathVariable String user, HttpServletRequest request) {
        if (!admin(request)) {
            return notAdmin();
        }
        return ResponseEntity.ok(keys.helpersOf(user).stream().map(h -> helperView(h, false)).toList());
    }

    @DeleteMapping("/board/users/keys/{keyId}")
    public ResponseEntity<?> adminRevoke(@PathVariable String keyId, HttpServletRequest request) {
        if (!admin(request)) {
            return notAdmin();
        }
        return keys.adminRevoke(keyId) ? ResponseEntity.noContent().build() : refused(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such live key");
    }

    // ---- the board lock

    @GetMapping("/board/holders")
    public ResponseEntity<?> holders(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String boardId) {
        if (boardId != null && !boardId.isBlank()) {
            return ResponseEntity.ok(holders.holder(boardId).map(List::of).orElse(List.of()));
        }
        return ResponseEntity.ok(holders.holders(project));
    }

    @PostMapping("/board/holders/take")
    public ResponseEntity<?> take(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : result(holders.take(c.get(), body.boardId(), body.project(), body.sessionId()));
    }

    @PostMapping("/board/holders/release")
    public ResponseEntity<?> release(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : result(holders.release(c.get(), body.boardId()));
    }

    @PostMapping("/board/holders/request")
    public ResponseEntity<?> ask(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : result(holders.request(c.get(), body.boardId(), body.note()));
    }

    @PostMapping("/board/holders/answer")
    public ResponseEntity<?> answer(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        if (body.answer() == null) {
            return refused(HttpStatus.BAD_REQUEST, "INVALID", "Answer HAND_OVER, RELEASE or KEEP");
        }
        return result(holders.answer(c.get(), body.boardId(), body.answer()));
    }

    @PutMapping("/board/holders/commenters")
    public ResponseEntity<?> commenters(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : result(holders.commenters(c.get(), body.boardId(), body.commenters()));
    }

    /** A commenter's chat message on a held board: it waits for the holder's OK (Claude never sees it before). */
    @PostMapping("/board/holders/pending")
    public ResponseEntity<?> submit(@Valid @RequestBody PendingDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        HoldersUseCase.PendingOutcome out = holders.submit(c.get(), body.boardId(), body.project(), body.scope(), body.text());
        return out.message() != null ? ResponseEntity.status(HttpStatus.CREATED).body(out.message())
                : refused("HELD".equals(out.error()) ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST, out.error(), out.text());
    }

    @GetMapping("/board/holders/pending")
    public ResponseEntity<?> pending(@RequestParam String boardId, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? ResponseEntity.ok(List.of()) : ResponseEntity.ok(holders.pending(c.get(), boardId));
    }

    /** The holder's answer to one waiting message: {@code letClaudeAnswer} returns the text for their page to post. */
    @PostMapping("/board/holders/pending/{id}")
    public ResponseEntity<?> resolve(@PathVariable long id, @RequestBody Map<String, Boolean> body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        HoldersUseCase.PendingOutcome out = holders.resolve(c.get(), id, Boolean.TRUE.equals(body == null ? null : body.get("letClaudeAnswer")));
        if (out.message() == null) {
            return refused("NOT_FOUND".equals(out.error()) ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT, out.error(), out.text());
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("message", out.message());
        m.put("post", out.text());
        return ResponseEntity.ok(m);
    }

    @PostMapping("/board/holders/force-release")
    public ResponseEntity<?> forceRelease(@Valid @RequestBody HoldDto body, HttpServletRequest request) {
        return admin(request) ? result(holders.forceRelease(body.boardId())) : notAdmin();
    }

    // ---- sessions and commands

    @GetMapping("/board/sessions")
    public ResponseEntity<?> sessions(@RequestParam(defaultValue = "") String project, @RequestParam(defaultValue = "") String boardId,
                                      @RequestParam(defaultValue = "100") int limit) {
        return ResponseEntity.ok(sessions.sessions(project, boardId, limit));
    }

    @PutMapping("/board/sessions")
    public ResponseEntity<?> report(@Valid @RequestBody SessionDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty() || !c.get().isHelper()) {
            return unknown();
        }
        try {
            return ResponseEntity.ok(sessions.report(c.get(), new SessionsUseCase.Report(body.id(), body.boardId(), body.project(),
                    body.cliSessionId(), body.desktopId(), body.cwd(), body.title(), body.state(), body.openIn(), body.lastChatSeq(),
                    body.tokensToday(), body.makeCurrent())));
        } catch (IllegalArgumentException e) {
            return refused(HttpStatus.BAD_REQUEST, "INVALID", e.getMessage());
        }
    }

    @PostMapping("/board/helper-commands")
    public ResponseEntity<?> queue(@Valid @RequestBody CommandDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        SessionsUseCase.CommandOutcome out = sessions.queue(c.get(), body.helperKeyId(), body.kind(), body.boardId(), body.project(),
                body.sessionId(), body.args());
        if (out.command() != null) {
            return ResponseEntity.status(HttpStatus.CREATED).body(out.command());
        }
        return refused("NOT_FOUND".equals(out.error()) ? HttpStatus.NOT_FOUND : "HELD".equals(out.error()) ? HttpStatus.FORBIDDEN
                : HttpStatus.BAD_REQUEST, out.error(), out.message());
    }

    @GetMapping("/board/helper-commands")
    public ResponseEntity<?> commands(@RequestParam(defaultValue = "50") int limit, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        return c.isEmpty() ? unknown() : ResponseEntity.ok(sessions.commands(c.get(), limit));
    }

    @PostMapping("/board/helper-commands/{id}/cancel")
    public ResponseEntity<?> cancel(@PathVariable String id, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty()) {
            return unknown();
        }
        return sessions.cancel(c.get(), id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> refused(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such waiting command of yours"));
    }

    /** The helper takes its commands - or waits (at most 50 s) for one, woken by the queueing itself, never by polling. */
    @PostMapping("/board/helper-commands/claim")
    public DeferredResult<ResponseEntity<?>> claim(@Valid @RequestBody ClaimDto body, HttpServletRequest request) {
        DeferredResult<ResponseEntity<?>> result = new DeferredResult<>(Math.max(1, wait(body)) * 1000L);
        Optional<Caller> c = caller(request);
        if (c.isEmpty() || !c.get().isHelper()) {
            result.setResult(unknown());
            return result;
        }
        int max = body.max() == null ? 5 : body.max();
        List<HelperCommand> now = sessions.claim(c.get(), max);
        if (!now.isEmpty() || wait(body) == 0) {
            result.setResult(ResponseEntity.ok(now));
            return result;
        }
        AtomicReference<AutoCloseable> handle = new AtomicReference<>();
        AtomicBoolean done = new AtomicBoolean();
        Runnable check = () -> CompletableFuture.runAsync(() -> {
            if (done.get()) {
                return;
            }
            List<HelperCommand> taken = sessions.claim(c.get(), max);
            if (taken.isEmpty()) {
                return;
            }
            if (done.compareAndSet(false, true)) {
                result.setResult(ResponseEntity.ok(taken));
            } else {
                taken.forEach(x -> sessions.report(c.get(), x.id(), HelperCommand.State.QUEUED, null));
            }
        });
        result.onTimeout(() -> {
            if (done.compareAndSet(false, true)) {
                result.setResult(ResponseEntity.ok(List.of()));
            }
        });
        result.onCompletion(() -> {
            done.set(true);
            close(handle.get());
        });
        handle.set(sessions.onQueued(check));
        // a command queued between the first claim and subscribing must not wait for the next one
        check.run();
        return result;
    }

    @PutMapping("/board/helper-commands/{id}")
    public ResponseEntity<?> commandReport(@PathVariable String id, @Valid @RequestBody CommandReportDto body, HttpServletRequest request) {
        Optional<Caller> c = caller(request);
        if (c.isEmpty() || !c.get().isHelper()) {
            return unknown();
        }
        return sessions.report(c.get(), id, body.state(), body.result()).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> refused(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such command for this helper"));
    }

    @GetMapping("/board/audit")
    public ResponseEntity<?> audit(@RequestParam String boardId, @RequestParam(defaultValue = "200") int limit) {
        return ResponseEntity.ok(sessions.audit(boardId, limit));
    }

    // ---- helpers

    private Optional<Caller> caller(HttpServletRequest request) {
        return keys.authenticate(request.getHeader(Keys.HEADER));
    }

    private boolean admin(HttpServletRequest request) {
        AdminRequestCheck check = adminCheck.getIfAvailable();
        if (check != null) {
            return check.admin(request);
        }
        try {
            boolean forwarded = Collections.list(request.getHeaderNames()).stream()
                    .anyMatch(h -> h.equalsIgnoreCase("X-Forwarded-For") || h.equalsIgnoreCase("Forwarded") || h.toLowerCase().startsWith("cf-"));
            return !forwarded && InetAddress.getByName(request.getRemoteAddr()).isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }

    private static Map<String, Object> helperView(Helper h, boolean own) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("keyId", h.keyId());
        m.put("user", h.user());
        m.put("machine", h.machine());
        m.put("online", h.online(Instant.now()));
        m.put("lastSeen", h.lastSeen());
        m.put("createdAt", h.createdAt());
        if (own) {
            m.put("claudeAccount", nz(h.claudeAccount()));
            m.put("ip", nz(h.ip()));
            m.put("info", h.info());
        }
        return m;
    }

    private static ResponseEntity<?> result(HoldersUseCase.Result r) {
        if (r.ok()) {
            return ResponseEntity.ok(r.holder() == null ? Map.of() : r.holder());
        }
        HttpStatus status = switch (r.error()) {
            case "HELD" -> HttpStatus.CONFLICT;
            case "NOT_FOUND" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_REQUEST;
        };
        return refused(status, r.error(), r.message());
    }

    private static ResponseEntity<?> unknown() {
        return refused(HttpStatus.UNAUTHORIZED, "NOT_PAIRED", "Pair this browser with your Alfred helper first (My settings ▸ Pair)");
    }

    private static ResponseEntity<?> notAdmin() {
        return refused(HttpStatus.FORBIDDEN, "NOT_ADMIN", "Only the Alfred server's own machine may do this");
    }

    static ResponseEntity<?> refused(HttpStatus status, String error, String message) {
        return ResponseEntity.status(status).body(Map.of("error", error, "message", message == null ? "" : message));
    }

    private static int wait(ClaimDto body) {
        return Math.max(0, Math.min(MAX_WAIT_SECONDS, body.waitSeconds() == null ? 0 : body.waitSeconds()));
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static void close(AutoCloseable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
                // nothing to release
            }
        }
    }

    public record RegisterDto(@Size(max = 200) String user, @Size(max = 200) String machine, @Size(max = 200) String claudeAccount) {
    }

    public record PairDto(@Size(max = 20) String code, @Size(max = 200) String label) {
    }

    public record HoldDto(@Size(max = 200) String boardId, @Size(max = 100) String project, @Size(max = 100) String sessionId,
                          @Size(max = 500) String note, HoldersUseCase.Answer answer, @Size(max = 20) List<@Size(max = 200) String> commenters) {
    }

    public record PendingDto(@Size(max = 200) String boardId, @Size(max = 100) String project, @Size(max = 200) String scope,
                             @Size(max = 16 * 1024) String text) {
    }

    public record SessionDto(@Size(max = 100) String id, @Size(max = 200) String boardId, @Size(max = 100) String project,
                             @Size(max = 100) String cliSessionId, @Size(max = 120) String desktopId, @Size(max = 1000) String cwd,
                             @Size(max = 300) String title, BoardSession.State state, BoardSession.OpenIn openIn, Long lastChatSeq,
                             Long tokensToday, Boolean makeCurrent) {
    }

    public record CommandDto(@Size(max = 40) String helperKeyId, HelperCommand.Kind kind, @Size(max = 200) String boardId,
                             @Size(max = 100) String project, @Size(max = 100) String sessionId, @Size(max = 16 * 1024) String args) {
    }

    public record ClaimDto(@Min(0) @Max(20) Integer max, @Min(0) @Max(MAX_WAIT_SECONDS) Integer waitSeconds) {
    }

    public record CommandReportDto(HelperCommand.State state, @Size(max = 4000) String result) {
    }
}
