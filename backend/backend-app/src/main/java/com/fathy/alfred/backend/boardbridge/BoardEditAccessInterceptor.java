package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Refuses a /board write the viewer may not make with 403 {error, message}; reads always pass. */
public class BoardEditAccessInterceptor implements HandlerInterceptor {

    private final BoardEditAccess access;
    private final ObjectMapper json = new ObjectMapper();

    public BoardEditAccessInterceptor(BoardEditAccess access) {
        this.access = access;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws IOException {
        String method = request.getMethod();
        if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
            return true;
        }
        BoardEditAccess.Decision decision = access.decide(request);
        if (decision.editable()) {
            return true;
        }
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(json.writeValueAsString(Map.of("error", "edit-not-allowed", "reason", decision.reason(),
                "message", decision.howToEdit())));
        return false;
    }
}
