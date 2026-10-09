package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.DockerSettingsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvConflictException;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.application.port.out.HistoryPort;
import com.fathy.alfred.backend.server.application.port.out.LiveSettingsPort;
import com.fathy.alfred.backend.server.application.port.out.PendingRestartPort;
import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.BiFunction;

/** In-memory ports for the server slice's service tests. */
final class Fakes {

    private Fakes() {
    }

    static final Map<String, String> DEFAULTS = Map.ofEntries(
            Map.entry("REVERSE_PROXY_ENABLED", "false"), Map.entry("INTERNAL_CALL_SERVICES", ""),
            Map.entry("INTERNAL_CALLS_RETENTION_ROWS", "1500"), Map.entry("ALFRED_UI_PORT", "3000"),
            Map.entry("ALFRED_OUTBOUND_PROXY_LISTEN", "127.0.0.2:443"), Map.entry("ALFRED_SETTINGS_EDIT_FROM", "local,lan"),
            Map.entry("ALFRED_CALLS_MAX_SIZE_BYTES", "10737418240"), Map.entry("ALFRED_DB_CAPTURE_MAX_SIZE_BYTES", "4294967296"),
            Map.entry("ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES", "2147483648"), Map.entry("ALFRED_MEMORY", "2g"),
            Map.entry("ALFRED_LOGS_DIR", "./logs-drop"), Map.entry("ALFRED_LOGS_WATCH_DIRS", ""),
            Map.entry("ALFRED_LOGS_WATCH_MODE", "auto"), Map.entry("WILDFLY_PORT_OFFSET_ENABLED", "false"),
            Map.entry("WILDFLY_HOME", ""), Map.entry("WEBHOOK_SECRET", ""), Map.entry("ALFRED_LOGS_AGENT_SECRET", ""));

    static final class Env implements EnvFilePort {
        String content;

        Env(String content) {
            this.content = content;
        }

        @Override
        public boolean exists() {
            return content != null;
        }

        @Override
        public EnvDocument read() {
            return EnvDocument.parse(content == null ? "" : content);
        }

        @Override
        public void write(EnvDocument document, String expectedHash) {
            String current = EnvDocument.hashOf(content == null ? "" : content);
            if (expectedHash != null && !expectedHash.equals(current)) {
                throw new EnvConflictException(current);
            }
            content = document.render();
        }

        @Override
        public String location() {
            return "/opt/alfred/.env";
        }
    }

    static final class History implements HistoryPort {
        final List<HistoryEntry> entries = new ArrayList<>();
        final Map<Long, String> before = new HashMap<>();
        String lastAfter;

        @Override
        public long append(HistoryEntry.HistorySource source, String sourceDetail, List<HistoryEntry.Change> changes,
                           String contentBefore, String contentAfter) {
            long id = entries.size() + 1;
            entries.add(new HistoryEntry(id, Instant.EPOCH, source, sourceDetail, changes, "before-" + id));
            before.put(id, contentBefore);
            lastAfter = contentAfter;
            return id;
        }

        @Override
        public List<HistoryEntry> recent(int limit) {
            List<HistoryEntry> copy = new ArrayList<>(entries);
            java.util.Collections.reverse(copy);
            return copy.subList(0, Math.min(limit, copy.size()));
        }

        @Override
        public Optional<HistoryEntry> find(long id) {
            return entries.stream().filter(e -> e.id() == id).findFirst();
        }

        @Override
        public Optional<String> contentBefore(long id) {
            return Optional.ofNullable(before.get(id));
        }

        @Override
        public Optional<String> lastKnownContent() {
            return Optional.ofNullable(lastAfter);
        }
    }

    static final class Pending implements PendingRestartPort {
        List<PendingRestart> list = new ArrayList<>();

        @Override
        public List<PendingRestart> all() {
            return List.copyOf(list);
        }

        @Override
        public void replace(List<PendingRestart> pending) {
            list = new ArrayList<>(pending);
        }
    }

    static final class Live implements LiveSettingsPort {
        final List<String> applied = new ArrayList<>();

        @Override
        public void apply(String key, Map<String, String> effective) {
            if (key.equals("ALFRED_MEMORY") || key.startsWith("INTERNAL_CALL_SERVICES") || key.equals("REVERSE_PROXY_ENABLED")
                    || key.equals("ALFRED_OUTBOUND_PROXY_LISTEN")) {
                throw new IllegalArgumentException("not live");
            }
            applied.add(key + "=" + effective.get(key));
        }
    }

    static final class Supervisor implements SupervisorPort {
        int reloads;
        int backendRestarts;
        int proxyRestarts;
        boolean available = true;
        /** Docker's agent host: attaches although no supervisor runs. Null: as {@link #available}. */
        Boolean attaches;

        @Override
        public boolean attaches() {
            return attaches == null ? available : attaches;
        }

        @Override
        public boolean available() {
            return available;
        }

        @Override
        public List<String> reload() {
            reloads++;
            return List.of("REVERSE");
        }

        final List<String> updatesAsked = new ArrayList<>();
        boolean acceptUpdates = true;
        com.fathy.alfred.backend.server.domain.model.UpdateJob job = com.fathy.alfred.backend.server.domain.model.UpdateJob.idle();

        @Override
        public boolean installUpdate(String version, String url, String sha256, long size) {
            updatesAsked.add(version + " " + url + " " + sha256 + " " + size);
            return acceptUpdates;
        }

        @Override
        public Optional<com.fathy.alfred.backend.server.domain.model.UpdateJob> updateJob() {
            return available ? Optional.of(job) : Optional.empty();
        }

        @Override
        public void restartBackend() {
            backendRestarts++;
        }

        @Override
        public void restartProxies() {
            proxyRestarts++;
        }

        @Override
        public Optional<List<ServerStatus.ProcessStatus>> processes() {
            return Optional.empty();
        }

        final List<String> attachesAsked = new ArrayList<>();
        List<ServerStatus.AgentAttach> agents = List.of();

        @Override
        public Optional<List<ServerStatus.AgentAttach>> agents() {
            return available ? Optional.of(agents) : Optional.empty();
        }

        @Override
        public boolean attachAgent(String project, List<String> features, boolean force) {
            if (!attaches()) {
                return false;
            }
            attachesAsked.add(project + " " + String.join(",", features) + (force ? " force" : ""));
            return true;
        }
    }

    static final class Events implements ServerEventsPort {
        final List<String> sent = new ArrayList<>();

        @Override
        public void serverChanged(String what) {
            sent.add(what);
        }
    }

    static DefaultsPort defaults() {
        return () -> DEFAULTS;
    }

    static DockerSettingsPort docker(Map<String, String> values) {
        return key -> Optional.ofNullable(values.get(key));
    }

    static Clock clock() {
        return Clock.fixed(Instant.parse("2026-10-07T12:00:00Z"), ZoneOffset.UTC);
    }

    static BiFunction<Map<String, String>, Set<String>, List<ValidationResult>> noProbes() {
        return (effective, keys) -> List.of();
    }

    static final class Rig {
        final Env env;
        final History history = new History();
        final Pending pending = new Pending();
        final Live live = new Live();
        final Supervisor supervisor = new Supervisor();
        final Events events = new Events();
        final ServerSettingsService service;

        Rig(String envContent, RuntimeMode mode, Map<String, String> docker) {
            env = new Env(envContent);
            service = new ServerSettingsService(env, defaults(), history, pending, live, supervisor, docker(docker), events,
                    mode, clock(), noProbes());
        }

        Rig(String envContent) {
            this(envContent, RuntimeMode.NATIVE, Map.of());
        }
    }
}
