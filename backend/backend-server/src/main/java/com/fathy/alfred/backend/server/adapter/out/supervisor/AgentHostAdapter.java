package com.fathy.alfred.backend.server.adapter.out.supervisor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;

import java.nio.file.Path;
import java.util.Optional;

/**
 * Docker's stand-in for the supervisor, for attaching only: the agent host (alfred_agent_host.py) that start.py runs
 * on the machine, reached at {@code ALFRED_AGENT_HOST_URL} (host.docker.internal) with {@code ALFRED_AGENT_HOST_TOKEN}.
 * It speaks the supervisor's {@code GET /status} and {@code POST /agents/attach}, so the Server card, the attach modes
 * and the ◆ popover work as natively. It runs no Alfred process: {@link #available()} stays false, so restarts,
 * reloads and updates are still refused in Docker mode.
 */
public class AgentHostAdapter extends SupervisorControlAdapter {

    private final String url;
    private final String token;

    public AgentHostAdapter(String url, String token, ObjectMapper mapper) {
        super(Path.of("unused"), RuntimeMode.DOCKER, mapper);
        this.url = url == null ? "" : url.replaceAll("/+$", "");
        this.token = token == null ? "" : token;
    }

    @Override
    public boolean available() {
        return false;
    }

    @Override
    public boolean attaches() {
        return !url.isBlank() && !token.isBlank();
    }

    @Override
    protected Optional<Endpoint> endpoint() {
        return attaches() ? Optional.of(new Endpoint(url, token)) : Optional.empty();
    }
}
