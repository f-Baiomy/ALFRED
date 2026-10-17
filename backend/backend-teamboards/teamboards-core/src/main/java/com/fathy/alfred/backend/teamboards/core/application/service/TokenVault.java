package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The tracker tokens (specs/028 FR-001..004, R1): in memory only, one per connection, 8 hours from entry, the last one
 * entered wins. Never written to disk, a log, a response or the MCP; a restart or Forget drops it. Its owner is who
 * "me" is.
 */
@Component
public class TokenVault {

    public static final Duration LIFETIME = Duration.ofHours(8);

    /** A live token and whose it is. {@code toString} never prints the token. */
    public record Entry(Token token, PersonRow owner, Instant enteredAt, Instant expiresAt) {
        @Override
        public String toString() {
            return "Entry[" + (owner == null ? "?" : owner.name()) + ", until " + expiresAt + "]";
        }
    }

    private final Map<String, Entry> tokens = new ConcurrentHashMap<>();
    private final Clock clock;

    public TokenVault() {
        this(Clock.systemUTC());
    }

    TokenVault(Clock clock) {
        this.clock = clock;
    }

    /** Puts the token for a connection (replacing any other); the previous owner, if it was someone else. */
    public Optional<PersonRow> put(String conn, Token token, PersonRow owner) {
        Instant now = clock.instant();
        Entry old = tokens.put(conn, new Entry(token, owner, now, now.plus(LIFETIME)));
        if (old == null || old.owner() == null || owner == null || old.owner().extId().equals(owner.extId())) {
            return Optional.empty();
        }
        return Optional.of(old.owner());
    }

    /** The live entry, or empty once it expired (an expired one is dropped on the way). */
    public Optional<Entry> entry(String conn) {
        Entry e = conn == null ? null : tokens.get(conn);
        if (e == null) {
            return Optional.empty();
        }
        if (!clock.instant().isBefore(e.expiresAt())) {
            tokens.remove(conn, e);
            return Optional.empty();
        }
        return Optional.of(e);
    }

    public Optional<Token> token(String conn) {
        return entry(conn).map(Entry::token);
    }

    public Optional<PersonRow> owner(String conn) {
        return entry(conn).map(Entry::owner);
    }

    public boolean forget(String conn) {
        return tokens.remove(conn) != null;
    }

    /** A token the tracker refused is useless: dropped so the page asks for a new one. */
    public void rejected(String conn, Token token) {
        Entry e = tokens.get(conn);
        if (e != null && e.token().equals(token)) {
            tokens.remove(conn, e);
        }
    }
}
