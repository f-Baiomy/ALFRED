package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCallerPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * The tracker tokens (specs/028 FR-001..004, R1): in memory only, one per connection, 8 hours from entry. Never written to
 * disk, a log, a response or the MCP; a restart or Forget drops it. Its owner is who "me" is.
 *
 * <p>Since specs/031 a token is also one per USER: a paired user's token (entered from their PC by the helper, or from
 * their paired browser) is used for that user's own requests only - another user never reads with it. A request from an
 * unpaired caller uses the shared token as before (the last one entered without a user wins). Work outside a request
 * (lists, hooks, watch rules) uses the newest live token of the connection, as it always did.
 */
@Component
public class TokenVault {

    public static final Duration LIFETIME = Duration.ofHours(8);
    private static final String SHARED = "";

    /** A live token and whose it is. {@code toString} never prints the token. */
    public record Entry(Token token, PersonRow owner, Instant enteredAt, Instant expiresAt) {
        @Override
        public String toString() {
            return "Entry[" + (owner == null ? "?" : owner.name()) + ", until " + expiresAt + "]";
        }
    }

    private record Key(String conn, String user) {
    }

    private final Map<Key, Entry> tokens = new ConcurrentHashMap<>();
    private final Clock clock;
    private final Supplier<Optional<String>> caller;

    public TokenVault() {
        this(Clock.systemUTC());
    }

    @Autowired
    public TokenVault(ObjectProvider<TeamCallerPort> caller) {
        this(Clock.systemUTC(), () -> {
            TeamCallerPort p = caller.getIfAvailable();
            return p == null ? Optional.empty() : p.user();
        });
    }

    TokenVault(Clock clock) {
        this(clock, Optional::empty);
    }

    TokenVault(Clock clock, Supplier<Optional<String>> caller) {
        this.clock = clock;
        this.caller = caller;
    }

    private String user() {
        try {
            return caller.get().map(u -> u.strip().toLowerCase(java.util.Locale.ROOT)).filter(u -> !u.isEmpty()).orElse(SHARED);
        } catch (RuntimeException e) {
            return SHARED;
        }
    }

    /** Puts the token for a connection (replacing any other of the same user); the previous owner, if it was someone else. */
    public Optional<PersonRow> put(String conn, Token token, PersonRow owner) {
        Instant now = clock.instant();
        Entry old = tokens.put(new Key(conn, user()), new Entry(token, owner, now, now.plus(LIFETIME)));
        if (old == null || old.owner() == null || owner == null || old.owner().extId().equals(owner.extId())) {
            return Optional.empty();
        }
        return Optional.of(old.owner());
    }

    /**
     * The live entry for this caller, or empty once it expired (an expired one is dropped on the way): a paired user's own
     * token, else the shared one; outside a request, the connection's newest live token.
     */
    public Optional<Entry> entry(String conn) {
        if (conn == null) {
            return Optional.empty();
        }
        String user = user();
        if (!SHARED.equals(user)) {
            return live(new Key(conn, user)).or(() -> live(new Key(conn, SHARED)));
        }
        if (inRequest()) {
            return live(new Key(conn, SHARED));
        }
        return tokens.keySet().stream().filter(k -> k.conn().equals(conn)).map(this::live).flatMap(Optional::stream)
                .max(Comparator.comparing(Entry::enteredAt));
    }

    private Optional<Entry> live(Key key) {
        Entry e = tokens.get(key);
        if (e == null) {
            return Optional.empty();
        }
        if (!clock.instant().isBefore(e.expiresAt())) {
            tokens.remove(key, e);
            return Optional.empty();
        }
        return Optional.of(e);
    }

    /** Whether the current thread serves a request (a browser, a helper, the MCP) rather than background work. */
    private static boolean inRequest() {
        try {
            return org.springframework.web.context.request.RequestContextHolder.getRequestAttributes() != null;
        } catch (NoClassDefFoundError e) {
            return false;
        }
    }

    /**
     * Until when the caller's OWN token of a connection lives - never the shared one: a helper asks this on its heartbeat
     * and hands its kept token over again when it is gone (8 hours passed, or Alfred restarted) - specs/031.
     */
    public Optional<Instant> ownUntil(String conn) {
        String user = user();
        return conn == null || SHARED.equals(user) ? Optional.empty() : live(new Key(conn, user)).map(Entry::expiresAt);
    }

    public Optional<Token> token(String conn) {
        return entry(conn).map(Entry::token);
    }

    public Optional<PersonRow> owner(String conn) {
        return entry(conn).map(Entry::owner);
    }

    /** Forgets the caller's own token (a paired user's), or the shared one. */
    public boolean forget(String conn) {
        return tokens.remove(new Key(conn, user())) != null;
    }

    /** Every token of a connection (the connection was deleted). */
    public void forgetAll(String conn) {
        tokens.keySet().removeIf(k -> k.conn().equals(conn));
    }

    /** A token the tracker refused is useless: dropped so the page asks for a new one. */
    public void rejected(String conn, Token token) {
        tokens.entrySet().removeIf(e -> e.getKey().conn().equals(conn) && e.getValue().token().equals(token));
    }
}
