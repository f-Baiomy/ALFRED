package com.fathy.alfred.backend.server.domain.model;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.fathy.alfred.backend.server.domain.model.ApplyMode.LIVE;
import static com.fathy.alfred.backend.server.domain.model.ApplyMode.PROXIES;
import static com.fathy.alfred.backend.server.domain.model.ApplyMode.RESTART;

/**
 * Every deploy-time setting of a native install, in display order (specs/012-server-program research R8). Keys keep
 * their existing .env names (FR-014). How each one applies is decided by what the owning code can do at runtime:
 * a setting is LIVE only where the owning slice has a runtime setter; anything read once at startup (bean selection,
 * the listening port, the heap size) is honestly RESTART.
 */
public final class SettingCatalog {

    private static final long MB = 1024L * 1024;

    private static final List<SettingDefinition> ALL = List.of(
            def("REVERSE_PROXY_ENABLED", SettingGroup.PROJECTS, "Inbound logging",
                    "Log calls INTO your apps. Callers use the project's listen port; Alfred forwards to the app's own port.",
                    SettingKind.BOOLEAN, PROXIES),
            def("INTERNAL_CALL_SERVICES", SettingGroup.PROJECTS, "Projects",
                    "One row per app Alfred fronts: name, the port callers use, the app's own port, and optionally an outbound address that tags the app's outbound calls with its name.",
                    SettingKind.PROJECT_LIST, PROXIES),
            range("INTERNAL_CALLS_RETENTION_ROWS", SettingGroup.PROJECTS, "Inbound calls kept",
                    "Oldest inbound calls are removed once there are more than this.",
                    SettingKind.INTEGER, LIVE, 100L, 1_000_000L),

            def("ALFRED_UI_PORT", SettingGroup.NETWORK, "Web UI port",
                    "The one port for the UI, the API and Claude's tools (/mcp).",
                    SettingKind.PORT, RESTART),
            def("ALFRED_OUTBOUND_PROXY_LISTEN", SettingGroup.NETWORK, "Outbound proxy",
                    "Address your Java apps send outbound calls to (http.proxyHost / https.proxyHost and port).",
                    SettingKind.HOST_PORT, PROXIES),
            def("ALFRED_SETTINGS_EDIT_FROM", SettingGroup.NETWORK, "Who can change settings",
                    "local = this machine, lan = private network addresses (10.x, 172.16-31.x, 192.168.x), or addresses and ranges such as 192.168.1.0/24. The Cloudflare tunnel is always read-only.",
                    SettingKind.ACCESS_LIST, LIVE),

            range("ALFRED_CALLS_MAX_SIZE_BYTES", SettingGroup.STORAGE, "Outbound calls",
                    "Total size kept for outbound calls. The oldest are removed past it.",
                    SettingKind.SIZE_BYTES, LIVE, 10 * MB, null),
            range("INTERNAL_CALLS_MAX_SIZE_BYTES", SettingGroup.STORAGE, "Inbound calls",
                    "Total size kept for inbound calls. The oldest are removed past it, or past the count kept, whichever comes first.",
                    SettingKind.SIZE_BYTES, RESTART, 10 * MB, null),
            range("ALFRED_DB_CAPTURE_MAX_SIZE_BYTES", SettingGroup.STORAGE, "Database statements",
                    "Total size kept for captured database statements. The oldest are removed past it.",
                    SettingKind.SIZE_BYTES, LIVE, 10 * MB, null),
            range("ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES", SettingGroup.STORAGE, "Redis commands",
                    "Total size kept for captured Redis commands. The oldest are removed past it.",
                    SettingKind.SIZE_BYTES, LIVE, 10 * MB, null),
            def("ALFRED_MEMORY", SettingGroup.STORAGE, "Memory",
                    "Java heap for the backend (-Xmx), e.g. 2g or 1536m.",
                    SettingKind.MEMORY, RESTART),

            def("ALFRED_LOGS_DIR", SettingGroup.LOGS, "Drop folder",
                    "Folder whose log files the Logs tab can open. A relative path is relative to the Alfred folder.",
                    SettingKind.PATH, RESTART),
            def("ALFRED_LOGS_WATCH_DIRS", SettingGroup.LOGS, "Watched folders",
                    "Folders whose log files are followed live. Each has a short name and a path.",
                    SettingKind.FOLDER_LIST, LIVE),
            new SettingDefinition("ALFRED_LOGS_WATCH_MODE", SettingGroup.LOGS, "Watch mode",
                    "How Alfred hears about new log lines: auto picks events on Linux and the log agent on Windows.",
                    SettingKind.ENUM, RESTART, List.of("auto", "events", "agent"), null, null),

            def("WILDFLY_PORT_OFFSET_ENABLED", SettingGroup.WILDFLY, "Port offset sync",
                    "Keep WildFly on its original port next to the reverse proxy (legacy, optional).",
                    SettingKind.BOOLEAN, RESTART),
            def("WILDFLY_HOME", SettingGroup.WILDFLY, "WildFly home",
                    "WildFly install folder, used by the port offset sync. Empty when not used.",
                    SettingKind.PATH, RESTART),

            new SettingDefinition("ALFRED_UPDATE_MODE", SettingGroup.UPDATES, "Updates",
                    "off: never look for new releases. check: look once a day and show an update in the Server card. "
                    + "auto: also install it, inside the window below.",
                    SettingKind.ENUM, LIVE, List.of("off", "check", "auto"), null, null),
            def("ALFRED_UPDATE_URL", SettingGroup.UPDATES, "Release feed",
                    "The latest.json a release publishes next to its installers. GitHub Releases by default; a file URL "
                    + "to a folder on a share works for servers without internet.",
                    SettingKind.URL, LIVE),
            def("ALFRED_UPDATE_WINDOW", SettingGroup.UPDATES, "Auto-update window",
                    "When an automatic update may stop and start Alfred, as HH:MM-HH:MM in the server's time zone. "
                    + "Empty: any time.",
                    SettingKind.TIME_WINDOW, LIVE),

            def("WEBHOOK_SECRET", SettingGroup.SECRETS, "Webhook secret",
                    "Shared between the proxies, the agent and the backend. Generated at install.",
                    SettingKind.SECRET, RESTART),
            def("ALFRED_LOGS_AGENT_SECRET", SettingGroup.SECRETS, "Log agent secret",
                    "Shared between the log agent and the backend. Generated when first needed.",
                    SettingKind.SECRET, RESTART));

    private static final Map<String, SettingDefinition> BY_KEY = index();

    private SettingCatalog() {
    }

    public static List<SettingDefinition> all() {
        return ALL;
    }

    public static Optional<SettingDefinition> find(String key) {
        return Optional.ofNullable(BY_KEY.get(key));
    }

    private static Map<String, SettingDefinition> index() {
        Map<String, SettingDefinition> map = new LinkedHashMap<>();
        for (SettingDefinition definition : ALL) {
            map.put(definition.key(), definition);
        }
        return Map.copyOf(map);
    }

    private static SettingDefinition def(String key, SettingGroup group, String label, String help, SettingKind kind,
                                         ApplyMode applies) {
        return new SettingDefinition(key, group, label, help, kind, applies, List.of(), null, null);
    }

    private static SettingDefinition range(String key, SettingGroup group, String label, String help, SettingKind kind,
                                           ApplyMode applies, Long min, Long max) {
        return new SettingDefinition(key, group, label, help, kind, applies, List.of(), min, max);
    }
}
