package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

/** {@code {error, message, retryAfter?}} for every refused Team request (contracts/teamboards-rest.md). */
@RestControllerAdvice(basePackageClasses = TeamErrors.class)
public class TeamErrors {

    @ExceptionHandler(TeamException.class)
    public ResponseEntity<Map<String, Object>> refused(TeamException e) {
        return body(e);
    }

    public static ResponseEntity<Map<String, Object>> body(TeamException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", e.code().name());
        body.put("message", e.getMessage() == null ? "" : e.getMessage());
        if (e.retryAfter() != null) {
            body.put("retryAfter", e.retryAfter());
        }
        return ResponseEntity.status(e.code().status()).body(body);
    }
}
