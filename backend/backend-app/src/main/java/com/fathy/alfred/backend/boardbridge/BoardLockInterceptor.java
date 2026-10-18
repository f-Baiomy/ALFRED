package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.SessionsUseCase;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Holder;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The board lock (specs/031): a write on a board someone holds is refused with 409 HELD unless it comes from the holder -
 * a browser paired with their helper, or their session's Claude, both naming themselves with {@code X-Alfred-Key} - or is a
 * chat message or comment from a commenter the holder named. A board nobody holds is written as before. Runs after the
 * edit rule, so the tunnel and the IP rule still come first. Every write that went through on a board is one audit line.
 */
public class BoardLockInterceptor implements HandlerInterceptor {

    /** What the session's Claude or the browser says it writes through: a session id, or nothing for a browser. */
    static final String VIA_HEADER = "X-Alfred-Via";
    private static final String TARGET = BoardLockInterceptor.class.getName() + ".target";
    private static final String CALLER = BoardLockInterceptor.class.getName() + ".caller";

    private final BoardWriteTargets targets;
    private final KeysUseCase keys;
    private final HoldersUseCase holders;
    private final SessionsUseCase sessions;
    private final ObjectMapper json = new ObjectMapper();

    public BoardLockInterceptor(BoardWriteTargets targets, KeysUseCase keys, HoldersUseCase holders, SessionsUseCase sessions) {
        this.targets = targets;
        this.keys = keys;
        this.holders = holders;
        this.sessions = sessions;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
        String method = request.getMethod();
        if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
            return true;
        }
        BoardWriteTargets.Target target = targets.of(method, request.getRequestURI(), params(request), body(request));
        if (target.boards().isEmpty()) {
            return true;
        }
        Optional<Caller> caller = keys.authenticate(request.getHeader(Keys.HEADER));
        for (String board : target.boards()) {
            WriteDecision d = holders.mayWrite(caller, board, target.kind());
            if (!d.allowed()) {
                refuse(response, d.holder());
                return false;
            }
        }
        request.setAttribute(TARGET, target);
        request.setAttribute(CALLER, caller);
        return true;
    }

    @Override
    @SuppressWarnings("unchecked")
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        Object t = request.getAttribute(TARGET);
        if (!(t instanceof BoardWriteTargets.Target target) || ex != null || response.getStatus() >= 400) {
            return;
        }
        Optional<Caller> caller = (Optional<Caller>) request.getAttribute(CALLER);
        String via = request.getHeader(VIA_HEADER);
        String through = via != null && !via.isBlank() ? "session " + via.strip()
                : caller != null && caller.isPresent() ? caller.get().kind() == Caller.Kind.HELPER ? "helper" : "browser" : "unpaired";
        String what = request.getMethod() + " " + request.getRequestURI().substring("/board".length());
        for (String board : target.boards()) {
            sessions.audit(board, what, caller == null ? Optional.empty() : caller, through);
        }
    }

    private JsonNode body(HttpServletRequest request) {
        Object cached = request.getAttribute(BoardBodyCachingFilter.CACHED);
        if (!(cached instanceof byte[] bytes) || bytes.length == 0) {
            return null;
        }
        try {
            JsonNode node = json.readTree(new String(bytes, StandardCharsets.UTF_8));
            return node != null && node.isObject() ? node : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static Map<String, String> params(HttpServletRequest request) {
        Map<String, String> out = new LinkedHashMap<>();
        request.getParameterMap().forEach((k, v) -> {
            if (v != null && v.length > 0) {
                out.put(k, v[0]);
            }
        });
        return out;
    }

    private void refuse(HttpServletResponse response, Holder h) throws IOException {
        response.setStatus(HttpStatus.CONFLICT.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "HELD");
        body.put("message", "This board is held by " + h.user() + (h.machine() == null || h.machine().isBlank() ? "" : " on " + h.machine())
                + ". You can read it; ask them for it to write.");
        body.put("boardId", h.boardId());
        body.put("holder", h.user());
        body.put("machine", h.machine());
        response.getOutputStream().write(json.writeValueAsBytes(body));
    }
}
