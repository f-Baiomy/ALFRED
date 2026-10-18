package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCallerPort;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.util.Optional;

/**
 * The paired user behind the current request (specs/031), for the tracker token vault: their X-Alfred-Key, checked by the
 * sessions slice. Empty outside a request or for an unpaired caller.
 */
@Component
public class TeamCallerAdapter implements TeamCallerPort {

    private final KeysUseCase keys;

    public TeamCallerAdapter(KeysUseCase keys) {
        this.keys = keys;
    }

    @Override
    public Optional<String> user() {
        if (!(RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs)) {
            return Optional.empty();
        }
        return keys.authenticate(attrs.getRequest().getHeader(Keys.HEADER)).map(Caller::user);
    }
}
