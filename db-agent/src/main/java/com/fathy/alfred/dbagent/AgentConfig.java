package com.fathy.alfred.dbagent;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * The agent's arguments - the one string -javaagent / loadAgent can pass:
 * {@code alfredUrl=http://localhost:3000;project=wallet-app;secretFile=C:/projects/Alfred/Alfred/.env}.
 * The secret is read from {@code secretFile} (its {@code WEBHOOK_SECRET=} line) so it never sits on a command line or
 * in a process listing; {@code secret=} is accepted for -javaagent setups where a file is awkward. It is never logged.
 *
 * <p>Native installs (specs/012-server-program contracts/supervisor-and-agent.md) add {@code features=proxy,db,logs,redis}
 * - the whole desired set, applied again on every attach - {@code proxy=host:port} (the forward proxy) and
 * {@code caFile=} (its CA, trusted in-JVM while proxy is on). Without {@code features} the agent captures db, logs and
 * redis, as it always did.
 */
public final class AgentConfig {

    /** What backend's compose service uses when .env sets nothing - see docker-compose.yml's WEBHOOK_SECRET. */
    static final String DEFAULT_SECRET = "change-me-in-production";

    static final Set<String> KNOWN_FEATURES = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList("proxy", "db", "logs", "redis")));
    static final String DEFAULT_FEATURES = "db,logs,redis";
    static final String DEFAULT_PROXY = "127.0.0.2:443";

    final String alfredUrl;
    final String project;
    final String secret;
    final Set<String> features;
    final String proxy;
    final String caFile;

    AgentConfig(String alfredUrl, String project, String secret) {
        this(alfredUrl, project, secret, features(DEFAULT_FEATURES), DEFAULT_PROXY, null);
    }

    AgentConfig(String alfredUrl, String project, String secret, Set<String> features, String proxy, String caFile) {
        this.alfredUrl = alfredUrl;
        this.project = project;
        this.secret = secret;
        this.features = Collections.unmodifiableSet(features);
        this.proxy = proxy;
        this.caFile = caFile;
    }

    boolean has(String feature) {
        return features.contains(feature);
    }

    boolean captures() {
        return has("db") || has("logs") || has("redis");
    }

    /** The set in a fixed order, as published in {@code alfred.agent.features} ("" when none). */
    String featureList() {
        StringBuilder out = new StringBuilder();
        for (String feature : KNOWN_FEATURES) {
            if (features.contains(feature)) {
                out.append(out.length() == 0 ? "" : ",").append(feature);
            }
        }
        return out.toString();
    }

    /** Unknown names are dropped, so an older agent ignores a feature a newer Alfred asks for. */
    static Set<String> features(String list) {
        Set<String> out = new LinkedHashSet<>();
        for (String name : list.split(",")) {
            String feature = name.trim().toLowerCase(java.util.Locale.ROOT);
            if (KNOWN_FEATURES.contains(feature)) {
                out.add(feature);
            }
        }
        return out;
    }

    public static AgentConfig parse(String args) {
        Map<String, String> values = new HashMap<>();
        if (args != null) {
            for (String part : args.split(";")) {
                int eq = part.indexOf('=');
                if (eq > 0) {
                    values.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
                }
            }
        }
        String url = values.getOrDefault("alfredUrl", "http://localhost:3000");
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        String secret = values.get("secret");
        if (secret == null && values.containsKey("secretFile")) {
            secret = readSecret(values.get("secretFile"));
        }
        String proxy = values.get("proxy");
        String caFile = values.get("caFile");
        return new AgentConfig(url, values.getOrDefault("project", "unknown"), secret == null || secret.isEmpty() ? DEFAULT_SECRET : secret,
                features(values.getOrDefault("features", DEFAULT_FEATURES)), proxy == null || proxy.isEmpty() ? DEFAULT_PROXY : proxy,
                caFile == null || caFile.isEmpty() ? null : caFile);
    }

    static String readSecret(String file) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(Files.newInputStream(Paths.get(file)), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.startsWith("WEBHOOK_SECRET=")) {
                    String value = line.substring("WEBHOOK_SECRET=".length()).trim();
                    if (value.length() >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) {
                        value = value.substring(1, value.length() - 1);
                    }
                    return value;
                }
            }
        } catch (IOException e) {
            AgentLog.warn("could not read secretFile (" + e.getClass().getSimpleName() + ") - using the default secret");
        }
        return null;
    }
}
