package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.AgentStatusUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The live strip (FR-044, research R14). In memory only: it describes what Claude is doing right now. A status not
 * updated for {@link #EXPIRY} reads as STOPPED - computed on read, so nothing runs on a timer.
 */
@Service
public class AgentStatusService implements AgentStatusUseCase {

    static final Duration EXPIRY = Duration.ofMinutes(10);

    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final Map<String, AgentStatus> byProject = new ConcurrentHashMap<>();

    @Autowired
    public AgentStatusService(BoardNotificationPort notifications) {
        this(notifications, Clock.systemUTC());
    }

    AgentStatusService(BoardNotificationPort notifications, Clock clock) {
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public Optional<AgentStatus> status(String project) {
        AgentStatus s = byProject.get(key(project));
        if (s == null) {
            return Optional.empty();
        }
        if (s.state() != AgentStatus.State.STOPPED && s.updatedAt().plus(EXPIRY).isBefore(clock.instant())) {
            return Optional.of(s.withState(AgentStatus.State.STOPPED, s.updatedAt()));
        }
        return Optional.of(s);
    }

    @Override
    public AgentStatus update(String project, String cycleId, AgentStatus.State state, int callsChecked, int cardsAdded) {
        Instant now = clock.instant();
        AgentStatus previous = byProject.get(key(project));
        // A watch loop reporting while the user paused it must not resume itself.
        AgentStatus.State effective = previous != null && previous.state() == AgentStatus.State.PAUSED && state == AgentStatus.State.WATCHING
                ? AgentStatus.State.PAUSED : state == null ? AgentStatus.State.WATCHING : state;
        AgentStatus next = new AgentStatus(key(project), cycleId, effective, Math.max(0, callsChecked), Math.max(0, cardsAdded), now, now);
        byProject.put(key(project), next);
        notifications.agentStatus(next);
        return next;
    }

    @Override
    public Optional<AgentStatus> setState(String project, AgentStatus.State state) {
        AgentStatus s = byProject.get(key(project));
        if (s == null) {
            return Optional.empty();
        }
        AgentStatus next = s.withState(state, clock.instant());
        byProject.put(key(project), next);
        notifications.agentStatus(next);
        return Optional.of(next);
    }

    @Override
    public boolean paused(String project) {
        return status(project).map(s -> s.state() == AgentStatus.State.PAUSED).orElse(false);
    }

    private static String key(String project) {
        return project == null ? "" : project;
    }
}
