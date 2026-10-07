package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.InboundProjectsPort;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundProject;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.Thresholds;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The capture switch and settings per project. The switch itself is the flag file (the reverse proxy reads it on
 * every request); settings reach the agent on its next heartbeat (within 10 s). Projects are the ones the reverse
 * proxy fronts, plus any project an agent reported that is not (yet) configured there.
 */
@Service
public class DbCaptureProjectsService implements ManageDbCaptureUseCase {

    static final String UNKNOWN_PROJECT = "unknown";
    static final int MAX_LIST = 200;
    static final int MAX_PATTERN = 300;
    private static final Pattern TABLE = Pattern.compile("[A-Za-z0-9_$#.\\-]{1,128}");
    private static final Pattern FINGERPRINT = Pattern.compile("[0-9a-f]{1,64}");

    private final DbCaptureStorePort store;
    private final DbCaptureTogglePort toggle;
    private final LogLinkTogglePort logLink;
    /** The ⬢ Redis switch (specs/011-redis-capture). Optional for tests built before it. */
    private com.fathy.alfred.backend.dbcapture.application.port.out.RedisCaptureTogglePort redis;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setRedis(com.fathy.alfred.backend.dbcapture.application.port.out.RedisCaptureTogglePort redis) {
        this.redis = redis;
    }
    private final DbCaptureNotificationPort notifications;
    private final Optional<InboundProjectsPort> inbound;
    private final Clock clock;

    public DbCaptureProjectsService(DbCaptureStorePort store, DbCaptureTogglePort toggle, LogLinkTogglePort logLink,
                                    DbCaptureNotificationPort notifications, Optional<InboundProjectsPort> inbound, Optional<Clock> clock) {
        this.store = store;
        this.toggle = toggle;
        this.logLink = logLink;
        this.notifications = notifications;
        this.inbound = inbound;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    /** Re-flags a project's calls when its thresholds change (specs/010). Optional for tests. */
    private CallSignalsPublisher signals;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSignals(CallSignalsPublisher signals) {
        this.signals = signals;
    }

    private static boolean flagsMayChange(DbCaptureSettings before, DbCaptureSettings after) {
        return before == null || !java.util.Objects.equals(before.thresholds(), after.thresholds())
                || !java.util.Objects.equals(before.expectedFingerprints(), after.expectedFingerprints())
                || !java.util.Objects.equals(before.ignorePatterns(), after.ignorePatterns());
    }

    @Override
    public List<ProjectCaptureStatus> projects() {
        Map<String, Boolean> logging = new LinkedHashMap<>();
        for (InboundProject p : inbound.map(InboundProjectsPort::projects).orElse(List.of())) {
            if (!UNKNOWN_PROJECT.equals(p.name())) {
                logging.put(p.name(), p.inboundLogging());
            }
        }
        Map<String, AgentStatus> latestAgent = new LinkedHashMap<>();
        for (AgentStatus a : store.agents()) {
            AgentStatus known = latestAgent.get(a.project());
            if (known == null || (a.lastSeen() != null && (known.lastSeen() == null || a.lastSeen().compareTo(known.lastSeen()) > 0))) {
                latestAgent.put(a.project(), a);
            }
        }
        Set<String> names = new LinkedHashSet<>(logging.keySet());
        latestAgent.keySet().stream().filter(p -> p != null && !p.isBlank()).sorted().forEach(names::add);
        Instant now = clock.instant();
        List<ProjectCaptureStatus> out = new ArrayList<>();
        for (String name : names) {
            AgentStatus agent = latestAgent.get(name);
            boolean attached = agent != null && DbCaptureService.isRecent(agent.lastSeen(), now);
            out.add(new ProjectCaptureStatus(name, toggle.isEnabled(name), logging.getOrDefault(name, false), attached, agent, logLink.isOn(name),
                    logLevelOf(name), redis != null && redis.isOn(name), redisClients(agent), springCaches(agent)));
        }
        return out;
    }

    @Override
    public List<ProjectCaptureStatus> setEnabled(String project, boolean enabled) {
        String name = requireProject(project);
        if (enabled) {
            requireInboundLogging(name);
        }
        toggle.setEnabled(name, enabled);
        notifications.captureSettingsChanged(name);
        return projects();
    }

    @Override
    public List<ProjectCaptureStatus> setLogsOn(String project, boolean on) {
        String name = requireProject(project);
        if (on) {
            requireInboundLogging(name);
        }
        logLink.setOn(name, on);
        notifications.captureSettingsChanged(name);
        return projects();
    }

    @Override
    public List<ProjectCaptureStatus> setRedisOn(String project, boolean on) {
        String name = requireProject(project);
        if (on) {
            requireInboundLogging(name);
        }
        if (redis == null) {
            throw new IllegalStateException("the Redis switch is not available");
        }
        redis.setOn(name, on);
        notifications.captureSettingsChanged(name);
        return projects();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> redisClients(AgentStatus agent) {
        Object clients = agent == null || agent.redis() == null ? null : agent.redis().get("clients");
        return clients instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
    }

    @SuppressWarnings("unchecked")
    private static List<String> springCaches(AgentStatus agent) {
        Object caches = agent == null || agent.redis() == null ? null : agent.redis().get("springCaches");
        return caches instanceof List<?> l ? (List<String>) l : List.of();
    }

    @Override
    public boolean logsLinked(String project) {
        if (project == null || project.isBlank() || !logLink.isOn(project)) {
            return false;
        }
        return inbound.map(port -> port.projects().stream().anyMatch(p -> p.name().equals(project) && p.inboundLogging())).orElse(true);
    }

    private void requireInboundLogging(String name) {
        if (inbound.isPresent()) {
            boolean loggingOn = inbound.get().projects().stream().anyMatch(p -> p.name().equals(name) && p.inboundLogging());
            if (!loggingOn) {
                throw new InboundLoggingOffException(name);
            }
        }
    }

    @Override
    public DbCaptureSettings settings(String project) {
        return store.settings(requireProject(project));
    }

    @Override
    public DbCaptureSettings saveSettings(String project, DbCaptureSettings settings) {
        String name = requireProject(project);
        DbCaptureSettings valid = validate(settings);
        DbCaptureSettings before = store.settings(name);
        store.saveSettings(name, valid);
        notifications.captureSettingsChanged(name);
        if (signals != null && flagsMayChange(before, valid)) {
            signals.reflagProject(name); // stored flags follow the current thresholds (FR-022)
        }
        return valid;
    }

    @Override
    public DbCaptureSettings markExpected(String project, String fingerprint) {
        String name = requireProject(project);
        if (fingerprint == null || !FINGERPRINT.matcher(fingerprint).matches()) {
            throw new IllegalArgumentException("fingerprint must be the statement's hex fingerprint");
        }
        DbCaptureSettings current = store.settings(name);
        if (current.expectedFingerprints().contains(fingerprint)) {
            return current;
        }
        List<String> expected = new ArrayList<>(current.expectedFingerprints());
        expected.add(fingerprint);
        return saveSettings(name, new DbCaptureSettings(current.rowsPerResult(), current.beforeImageTables(), current.outsideCallCapture(),
                current.thresholds(), expected, current.ignorePatterns(), current.passThroughClasses(), current.callerFrames(), current.indexInfo(),
                current.logLevel(), current.redis()));
    }

    private String logLevelOf(String project) {
        DbCaptureSettings settings = store.settings(project);
        return settings == null ? DbCaptureSettings.DEFAULT_LOG_LEVEL : settings.logLevel();
    }

    private static String requireProject(String project) {
        if (project == null || project.isBlank() || project.length() > 100) {
            throw new IllegalArgumentException("project is required");
        }
        return project.strip();
    }

    /** Ranges per data-model.md; lists are trimmed, de-duplicated and capped. */
    static DbCaptureSettings validate(DbCaptureSettings s) {
        if (s == null) {
            throw new IllegalArgumentException("settings are required");
        }
        if (s.rowsPerResult() < 1 || s.rowsPerResult() > DbCaptureSettings.MAX_ROWS_PER_RESULT) {
            throw new IllegalArgumentException("rowsPerResult must be between 1 and " + DbCaptureSettings.MAX_ROWS_PER_RESULT);
        }
        Thresholds t = s.thresholds() == null ? Thresholds.DEFAULTS : s.thresholds();
        if (t.slowMs() < 1 || t.hugeRows() < 1 || t.repeatCount() < 2 || t.largeDeleteRows() < 1) {
            throw new IllegalArgumentException("thresholds must be positive (repeats at least 2)");
        }
        List<String> tables = clean(s.beforeImageTables(), "before-image table");
        for (String table : tables) {
            if (!TABLE.matcher(table).matches()) {
                throw new IllegalArgumentException("not a table name: " + table);
            }
        }
        List<String> expected = clean(s.expectedFingerprints(), "expected statement");
        List<String> ignore = clean(s.ignorePatterns(), "ignore pattern");
        List<String> passThrough = clean(s.passThroughClasses(), "pass-through class");
        if (s.callerFrames() > DbCaptureSettings.MAX_CALLER_FRAMES) {
            throw new IllegalArgumentException("frames per statement must be 1 to " + DbCaptureSettings.MAX_CALLER_FRAMES);
        }
        if (!DbCaptureSettings.LOG_LEVELS.contains(s.logLevel())) {
            throw new IllegalArgumentException("log level must be one of " + String.join(", ", DbCaptureSettings.LOG_LEVELS));
        }
        com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings r = s.redis();
        List<String> masks = clean(r.maskPatterns(), "masked key pattern");
        if (!com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings.SHOW_VALUES.contains(r.showValues())) {
            throw new IllegalArgumentException("show values must be DECODED or RAW");
        }
        if (r.slowMillis() > com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings.MAX_SLOW_MILLIS) {
            throw new IllegalArgumentException("slow Redis command must be 1 to 60000 ms");
        }
        return new DbCaptureSettings(s.rowsPerResult(), tables.stream().map(x -> x.toLowerCase(Locale.ROOT)).distinct().toList(),
                s.outsideCallCapture(), t, expected, ignore, passThrough, s.callerFrames(), s.indexInfo(), s.logLevel(),
                new com.fathy.alfred.backend.dbcapture.domain.model.RedisSettings(masks, r.showValues(), r.beforeImage(), r.slowMillis(),
                        r.housekeeping()));
    }

    private static List<String> clean(List<String> values, String what) {
        if (values == null) {
            return List.of();
        }
        List<String> out = values.stream().filter(v -> v != null && !v.isBlank()).map(String::strip).distinct().toList();
        if (out.size() > MAX_LIST) {
            throw new IllegalArgumentException("too many entries in " + what + " (max " + MAX_LIST + ")");
        }
        out.stream().filter(v -> v.length() > MAX_PATTERN).findFirst().ifPresent(v -> {
            throw new IllegalArgumentException(what + " is too long");
        });
        return out;
    }
}
