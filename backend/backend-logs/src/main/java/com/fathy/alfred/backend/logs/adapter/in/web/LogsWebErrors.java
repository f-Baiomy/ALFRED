package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * Maps the logs use cases' expected failures to HTTP statuses, in the same {"error": ...} shape as
 * GlobalExceptionHandler. Ordered first so the global catch-all never turns these into 500s.
 */
@RestControllerAdvice(basePackageClasses = LogsWebErrors.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LogsWebErrors {

    @ExceptionHandler(LogsException.class)
    public ResponseEntity<Map<String, String>> handle(LogsException e) {
        HttpStatus status = switch (e.kind()) {
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case BAD_REQUEST -> HttpStatus.BAD_REQUEST;
            case CONFLICT -> HttpStatus.CONFLICT;
            case TOO_LARGE -> HttpStatus.PAYLOAD_TOO_LARGE;
            case UNAVAILABLE -> HttpStatus.SERVICE_UNAVAILABLE;
            case FORBIDDEN -> HttpStatus.FORBIDDEN;
        };
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }
}
