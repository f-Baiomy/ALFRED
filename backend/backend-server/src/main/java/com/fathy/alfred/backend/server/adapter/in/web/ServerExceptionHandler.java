package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The server slice's error answers (contracts/server-api.md). Scoped to this slice's controllers; everything else
 * (validation of request bodies, unexpected errors) still goes through the platform's GlobalExceptionHandler.
 */
@RestControllerAdvice(basePackageClasses = ServerSettingsController.class)
public class ServerExceptionHandler {

    @ExceptionHandler(EditAccessInterceptor.EditNotAllowedException.class)
    public ResponseEntity<Map<String, Object>> notAllowed(EditAccessInterceptor.EditNotAllowedException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("reason", e.access().reason().name());
        body.put("howToEdit", e.access().howToEdit());
        body.put("clientAddress", e.access().clientAddress());
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(body);
    }

    @ExceptionHandler(SaveSettingsUseCase.SettingsRefusedException.class)
    public ResponseEntity<Map<String, Object>> refused(SaveSettingsUseCase.SettingsRefusedException e) {
        return ResponseEntity.unprocessableEntity().body(Map.of("message", e.getMessage(), "results", e.results()));
    }

    @ExceptionHandler(SaveSettingsUseCase.SettingsConflictException.class)
    public ResponseEntity<Map<String, Object>> conflict(SaveSettingsUseCase.SettingsConflictException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", e.getMessage(),
                "conflict", Map.of("changedKeys", e.changedKeys(), "currentHash", e.currentHash())));
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, Object>> dockerMode(IllegalStateException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("reason", "DOCKER_MODE", "message", e.getMessage()));
    }
}
