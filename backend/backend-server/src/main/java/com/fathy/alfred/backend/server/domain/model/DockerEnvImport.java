package com.fathy.alfred.backend.server.domain.model;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Brings a Docker install's .env into a native one (FR-002d, research R17): catalog settings are copied, keys that only
 * mean something to Docker Compose are dropped and listed, and paths relative to the Docker repo folder are made
 * absolute so log sources keep pointing at the same folders.
 */
public final class DockerEnvImport {

    /** Written by start.py/restart.py for Compose only; the native install derives or ignores them. */
    public static final Set<String> DOCKER_ONLY = Set.of(
            "BACKEND_PORT", "BACKEND_DEBUG_PORT", "COMPOSE_PROFILES", "FORWARD_PROXY_PORT_MAP", "ALFRED_LOGS_WATCH_MODE_RESOLVED");

    public record Result(EnvDocument document, List<String> copied, List<String> dropped) {
    }

    private DockerEnvImport() {
    }

    public static Result merge(EnvDocument nativeEnv, Map<String, String> dockerEnv, Path dockerFolder) {
        EnvDocument document = nativeEnv;
        List<String> copied = new ArrayList<>();
        List<String> dropped = new ArrayList<>();
        for (Map.Entry<String, String> entry : dockerEnv.entrySet()) {
            String key = entry.getKey();
            SettingDefinition definition = SettingCatalog.find(key).orElse(null);
            if (definition == null || DOCKER_ONLY.contains(key)) {
                dropped.add(key);
                continue;
            }
            String value = switch (definition.kind()) {
                case PATH -> absolute(entry.getValue(), dockerFolder);
                case FOLDER_LIST -> ServicesGrammar.serializeFolders(ServicesGrammar.parseFolders(entry.getValue(), w -> { }).stream()
                        .map(f -> new WatchedFolder(f.name(), absolute(f.path(), dockerFolder))).toList());
                default -> entry.getValue();
            };
            document = document.set(key, value, definition.group().envHeader());
            copied.add(key);
        }
        return new Result(document, copied, dropped);
    }

    private static String absolute(String path, Path base) {
        if (path == null || path.isBlank() || isAbsolute(path)) {
            return path;
        }
        return base.resolve(path).normalize().toString();
    }

    /** Absolute on either OS, whichever OS reads it: "/x", "C:\x", "C:/x", "\\server\share". */
    static boolean isAbsolute(String path) {
        return path.startsWith("/") || path.startsWith("\\\\") || path.matches("^[A-Za-z]:[\\\\/].*");
    }
}
