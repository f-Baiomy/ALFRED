package com.fathy.alfred.dbagent;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/**
 * The agent's arguments - the one string -javaagent / loadAgent can pass:
 * {@code alfredUrl=http://localhost:3000;project=wallet-app;secretFile=C:/projects/Alfred/Alfred/.env}.
 * The secret is read from {@code secretFile} (its {@code WEBHOOK_SECRET=} line) so it never sits on a command line or
 * in a process listing; {@code secret=} is accepted for -javaagent setups where a file is awkward. It is never logged.
 */
public final class AgentConfig {

    /** What backend's compose service uses when .env sets nothing - see docker-compose.yml's WEBHOOK_SECRET. */
    static final String DEFAULT_SECRET = "change-me-in-production";

    final String alfredUrl;
    final String project;
    final String secret;

    AgentConfig(String alfredUrl, String project, String secret) {
        this.alfredUrl = alfredUrl;
        this.project = project;
        this.secret = secret;
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
        return new AgentConfig(url, values.getOrDefault("project", "unknown"), secret == null || secret.isEmpty() ? DEFAULT_SECRET : secret);
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
