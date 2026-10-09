package com.fathy.alfred.backend.agentbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Makes the agent attach itself (docs/server.md "The agent attaches itself"): whenever an inbound call arrives for a
 * project whose agent is not reporting - and once at start for every project - the supervisor is asked to load the
 * agent into the JVM on that project's upstream port, with the features the project's settings say. The ask is
 * cheap and answered at once (the supervisor finds and loads on its own thread), but it is still an HTTP call, so
 * it never runs on the webhook thread. One ask per project per {@link #ASK_EVERY}: a JVM that is not there, or an
 * attach that fails, is reported on the Server card, not retried on every call. In Docker mode the agent host on the
 * machine (alfred_agent_host.py) does the attaching instead of the supervisor; nothing happens with the project's
 * attach mode {@code OFF}. In {@code AUTOMATIC} mode the supervisor's app watcher adds the moment
 * the app's port opens ({@link #appSeen}).
 */
@Component
public class AgentAutoAttachBridge implements NewInternalCallObserverPort {

    private static final Logger log = LoggerFactory.getLogger(AgentAutoAttachBridge.class);
    static final Duration ASK_EVERY = Duration.ofSeconds(30);

    private final ManageDbCaptureUseCase capture;
    private final ServerRuntimeUseCase runtime;
    private final Clock clock;
    private final ExecutorService asks;
    private final Map<String, Instant> lastAsked = new ConcurrentHashMap<>();

    /** Two constructors (the test's takes a clock and executor): Spring must be told which one is its. */
    @org.springframework.beans.factory.annotation.Autowired
    public AgentAutoAttachBridge(ManageDbCaptureUseCase capture, ServerRuntimeUseCase runtime) {
        this(capture, runtime, Clock.systemUTC(), Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "agent-auto-attach");
            t.setDaemon(true);
            return t;
        }));
    }

    AgentAutoAttachBridge(ManageDbCaptureUseCase capture, ServerRuntimeUseCase runtime, Clock clock, ExecutorService asks) {
        this.capture = capture;
        this.runtime = runtime;
        this.clock = clock;
        this.asks = asks;
    }

    /** Alfred started: every project whose switch is on gets its agent now, before the first call. */
    @EventListener(ApplicationReadyEvent.class)
    public void started() {
        asks.execute(() -> {
            try {
                for (ProjectCaptureStatus p : capture.projects()) {
                    ask(p.project(), p.attached());
                }
            } catch (RuntimeException e) {
                log.debug("auto-attach at start: {}", e.toString());
            }
        });
    }

    @Override
    public void onCallPrepared(CallRecord call) {
        String project = call.serviceName();
        if (project == null || project.isBlank()) {
            return;
        }
        Instant now = clock.instant();
        Instant last = lastAsked.get(project);
        if (last != null && Duration.between(last, now).compareTo(ASK_EVERY) < 0) {
            return;
        }
        lastAsked.put(project, now);
        asks.execute(() -> {
            try {
                boolean attached = capture.projects().stream().filter(p -> p.project().equals(project)).anyMatch(ProjectCaptureStatus::attached);
                ask(project, attached);
            } catch (RuntimeException e) {
                log.debug("auto-attach for {}: {}", project, e.toString());
            }
        });
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        return List.of();
    }

    /** True when the supervisor was asked. */
    boolean ask(String project, boolean attached) {
        if (attached) {
            return false;
        }
        DbCaptureSettings settings = capture.settings(project);
        if (!settings.attachesWhenAsked()) {
            return false;
        }
        lastAsked.put(project, clock.instant());
        boolean asked = runtime.attachAgent(project, settings.attachFeatures(), false);
        if (asked) {
            log.info("agent for {} is not reporting - asked the supervisor to attach it ({})", project, String.join(",", settings.attachFeatures()));
        }
        return asked;
    }

    /**
     * The supervisor saw the project's app appear on its upstream port (or restart: a new pid). In AUTOMATIC mode that
     * is the moment to attach - forced, so a pid that failed before does not wait out its retry window, and before the
     * first call rather than because of one. The other modes ignore it: the port is watched regardless of mode.
     */
    @EventListener
    public void appSeen(ServerRuntimeUseCase.AppSeen seen) {
        if (!seen.listening() || seen.project() == null || seen.project().isBlank()) {
            return;
        }
        asks.execute(() -> {
            try {
                DbCaptureSettings settings = capture.settings(seen.project());
                if (!settings.attachesAutomatically()) {
                    return;
                }
                lastAsked.put(seen.project(), clock.instant());
                if (runtime.attachAgent(seen.project(), settings.attachFeatures(), true)) {
                    log.info("{}'s app appeared on port {} (pid {}) - attaching the agent ({})", seen.project(), seen.port(), seen.pid(),
                            String.join(",", settings.attachFeatures()));
                }
            } catch (RuntimeException e) {
                log.debug("auto-attach on app start for {}: {}", seen.project(), e.toString());
            }
        });
    }
}
