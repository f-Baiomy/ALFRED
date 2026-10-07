package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** Tells the server slice the backend is up: pending restarts are now in effect, and history gets its baseline. */
@Component
public class ServerStartupListener {

    private final ServerRuntimeUseCase runtime;

    public ServerStartupListener(ServerRuntimeUseCase runtime) {
        this.runtime = runtime;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void started() {
        runtime.started();
    }
}
