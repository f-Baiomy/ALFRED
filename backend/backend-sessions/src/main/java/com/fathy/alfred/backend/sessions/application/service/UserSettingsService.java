package com.fathy.alfred.backend.sessions.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.sessions.application.port.in.UserSettingsUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsNotificationPort;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Iterator;
import java.util.Locale;
import java.util.Optional;

/**
 * See {@link UserSettingsUseCase}. A field named like a secret (token, pat, key, ...password, ...secret) is refused: the
 * Azure token is kept by the helper on the user's PC, never here.
 */
@Service
public class UserSettingsService implements UserSettingsUseCase {

    static final java.util.Set<String> SECRET_NAMES = java.util.Set.of("token", "pat", "accesstoken", "azuretoken", "apikey", "key");

    private final SessionsStorePort store;
    private final SessionsNotificationPort notifications;
    private final ObjectMapper json = new ObjectMapper();

    public UserSettingsService(SessionsStorePort store, SessionsNotificationPort notifications) {
        this.store = store;
        this.notifications = notifications;
    }

    @Override
    public String get(Caller caller) {
        return store.settings(caller.user()).orElse("{}");
    }

    @Override
    public Optional<String> put(Caller caller, String body) {
        if (body == null || body.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            return Optional.empty();
        }
        JsonNode node;
        try {
            node = json.readTree(body);
        } catch (Exception e) {
            return Optional.empty();
        }
        if (node == null || !node.isObject() || holdsSecret(node)) {
            return Optional.empty();
        }
        String clean = node.toString();
        store.putSettings(caller.user(), clean, Instant.now());
        notifications.changed("settings", null);
        return Optional.of(clean);
    }

    static boolean holdsSecret(JsonNode node) {
        if (node.isObject()) {
            for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) {
                String name = it.next();
                String n = name.toLowerCase(Locale.ROOT);
                if (SECRET_NAMES.contains(n) || n.endsWith("password") || n.endsWith("secret")) {
                    return true;
                }
                if (holdsSecret(node.get(name))) {
                    return true;
                }
            }
        } else if (node.isArray()) {
            for (JsonNode x : node) {
                if (holdsSecret(x)) {
                    return true;
                }
            }
        }
        return false;
    }
}
