package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.UpdateUseCase;
import com.fathy.alfred.backend.server.domain.model.UpdateStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The Server card's update row (contracts/server-api.md "Updates"). Reading and checking are open to anyone who can
 * open the UI - a check writes nothing - while installing is a write guarded by {@link EditAccessInterceptor}:
 * never through the tunnel.
 */
@RestController
@RequestMapping("/server/update")
public class ServerUpdateController {

    private final UpdateUseCase updates;

    public ServerUpdateController(UpdateUseCase updates) {
        this.updates = updates;
    }

    @GetMapping
    public UpdateStatus status() {
        return updates.status();
    }

    @PostMapping("/check")
    public UpdateStatus check() {
        return updates.check();
    }

    @PostMapping("/install")
    public ResponseEntity<Map<String, Object>> install() {
        updates.install();
        return ResponseEntity.accepted().body(Map.of("accepted", true));
    }
}
