package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.PcTokenUseCase;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/** See {@link PcTokenUseCase}. Memory only: a restart drops what was not taken yet. */
@Service
public class PcTokenService implements PcTokenUseCase {

    static final Duration LIFE = Duration.ofMinutes(10);
    static final int MAX_TOKEN = 2000;

    private record Waiting(String token, Instant expiresAt) {
        @Override
        public String toString() {
            return "Waiting[token=***, expiresAt=" + expiresAt + "]"; // never the token itself
        }
    }

    private final KeysUseCase keys;
    private final Clock clock;
    private final Map<String, Waiting> waiting = new ConcurrentHashMap<>();

    @Autowired
    public PcTokenService(KeysUseCase keys) {
        this(keys, Clock.systemUTC());
    }

    PcTokenService(KeysUseCase keys, Clock clock) {
        this.keys = keys;
        this.clock = clock;
    }

    @Override
    public boolean send(Caller caller, String helperKeyId, String token) {
        if (caller == null || helperKeyId == null) {
            return false;
        }
        String t = token == null ? "" : token.strip();
        if (t.length() > MAX_TOKEN || t.contains("\n")) {
            throw new IllegalArgumentException("That does not look like a token");
        }
        boolean own = keys.helpersOf(caller.user()).stream().anyMatch(h -> h.keyId().equals(helperKeyId));
        if (!own) {
            return false;
        }
        waiting.put(helperKeyId, new Waiting(t, clock.instant().plus(LIFE)));
        return true;
    }

    @Override
    public Optional<String> take(Caller helper) {
        if (helper == null || !helper.isHelper()) {
            return Optional.empty();
        }
        Waiting w = waiting.remove(helper.keyId());
        return w == null || w.expiresAt().isBefore(clock.instant()) ? Optional.empty() : Optional.of(w.token());
    }
}
