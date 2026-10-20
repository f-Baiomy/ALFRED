package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCallerPort;
import jakarta.servlet.http.HttpServletRequest;
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

    /**
     * Only the user's browser decides on a bundle (specs/038 G-4): a request naming Claude, coming through a session
     * (X-Alfred-Via - the MCP server and the runners send it), or carrying a helper's key is refused. With no paired key it
     * must at least be the browser's own fetch ({@code Sec-Fetch-Site: same-origin}) - a script or curl sends none.
     */
    @Override
    public Optional<String> refuseDecision() {
        if (!(RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs)) {
            return Optional.of("Only the user decides on what goes to the tracker - from the board in their browser");
        }
        HttpServletRequest r = attrs.getRequest();
        if ("claude".equalsIgnoreCase(String.valueOf(r.getHeader("X-Alfred-Actor")).strip())) {
            return Optional.of("Claude prepares changes for the tracker; only the user approves them");
        }
        if (r.getHeader("X-Alfred-Via") != null) {
            return Optional.of("A Claude session cannot approve - the user approves from the board in their browser");
        }
        Optional<Caller> caller = keys.authenticate(r.getHeader(Keys.HEADER));
        if (caller.isPresent()) {
            return caller.get().kind() == Caller.Kind.BROWSER ? Optional.empty()
                    : Optional.of("A helper's key cannot approve - the user approves from the board in their browser");
        }
        return "same-origin".equalsIgnoreCase(String.valueOf(r.getHeader("Sec-Fetch-Site")).strip()) ? Optional.empty()
                : Optional.of("Only the board in the user's browser approves what goes to the tracker");
    }
}
