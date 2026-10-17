package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.WatchRulesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.HookRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.HookInfo;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.HookReader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.net.URI;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The service hook (specs/028 US5). The secret is kept as a PBKDF2 hash and compared in constant time; a ping costs
 * nothing but reading ids; 60 a minute per connection at most. The route is the only Team write the tunnel forwards.
 */
@Service
public class HookService implements HookUseCase {

    private static final Logger log = LoggerFactory.getLogger(HookService.class);
    static final int ITERATIONS = 120_000;

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<BoardItemsUseCase> boardItems;
    private final ObjectProvider<WatchRulesUseCase> rules;
    private final Clock clock = Clock.systemUTC();
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Deque<Long>> recent = new ConcurrentHashMap<>();
    private final ExecutorService background = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "team-hook");
        t.setDaemon(true);
        return t;
    });

    public HookService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<BoardItemsUseCase> boardItems,
                       ObjectProvider<WatchRulesUseCase> rules) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boardItems = boardItems;
        this.rules = rules;
    }

    // ---------------------------------------------------------------------------------------------------- secrets

    static String hash(String secret, byte[] salt, int iterations) {
        try {
            PBEKeySpec spec = new PBEKeySpec(secret.toCharArray(), salt, iterations, 256);
            byte[] h = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            return "pbkdf2$" + iterations + "$" + Base64.getEncoder().encodeToString(salt) + "$" + Base64.getEncoder().encodeToString(h);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("PBKDF2 is not available", e);
        }
    }

    static boolean matches(String secret, String stored) {
        if (secret == null || secret.isEmpty() || stored == null) {
            return false;
        }
        String[] p = stored.split("\\$");
        if (p.length != 4 || !"pbkdf2".equals(p[0])) {
            return false;
        }
        try {
            String again = hash(secret, Base64.getDecoder().decode(p[2]), Integer.parseInt(p[1]));
            return MessageDigest.isEqual(again.getBytes(java.nio.charset.StandardCharsets.UTF_8), stored.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    @Override
    public String rotateSecret(String conn) {
        live.stored(conn);
        byte[] raw = new byte[24];
        random.nextBytes(raw);
        String secret = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        byte[] salt = new byte[16];
        random.nextBytes(salt);
        cache.putHookSecret(conn, hash(secret, salt, ITERATIONS), clock.instant());
        signals.changed(conn, "hook");
        return secret;
    }

    @Override
    public HookInfo putPublicAddress(String conn, String address) {
        live.stored(conn);
        String a = address == null || address.isBlank() ? null : address.strip().replaceAll("/+$", "");
        if (a != null) {
            try {
                URI u = URI.create(a);
                if (u.getHost() == null || !("https".equalsIgnoreCase(u.getScheme()) || "http".equalsIgnoreCase(u.getScheme())) || a.length() > 300) {
                    throw TeamException.invalid("The public address is an http(s) address, e.g. https://alfred.example.com");
                }
            } catch (IllegalArgumentException e) {
                throw TeamException.invalid("The public address is an http(s) address, e.g. https://alfred.example.com");
            }
        }
        cache.putPublicAddress(conn, a);
        signals.changed(conn, "hook");
        return info(conn);
    }

    @Override
    public HookInfo info(String conn) {
        StoredConnection c = live.stored(conn);
        Optional<HookRow> h = cache.hook(conn);
        String address = h.map(HookRow::publicAddress).orElse(null);
        return new HookInfo(conn, (address == null ? "" : address) + "/teamboards/hooks/" + c.kind(), h.map(HookRow::lastPingAt).orElse(null),
                h.map(HookRow::lastEvent).orElse(null), h.map(HookRow::badPings).orElse(0), cache.waiting(conn), address,
                h.map(HookRow::secretHash).filter(s -> s != null).isPresent());
    }

    // ------------------------------------------------------------------------------------------------------- ping

    @Override
    public Ping ping(String kind, String secret, String body) {
        if (!allow("route:" + kind, 2 * PER_MINUTE)) {
            return Ping.TOO_MANY; // checked before any hashing: a flood of bad secrets costs nothing
        }
        StoredConnection conn = null;
        Connector k = null;
        for (StoredConnection c : cache.connections()) {
            if (!c.kind().equals(kind)) {
                continue;
            }
            Optional<HookRow> h = cache.hook(c.id());
            if (h.isPresent() && matches(secret, h.get().secretHash())) {
                conn = c;
                k = live.connector(c.kind()).orElse(null);
                break;
            }
        }
        if (conn == null) {
            for (StoredConnection c : cache.connections()) {
                if (c.kind().equals(kind) && cache.hook(c.id()).map(HookRow::secretHash).isPresent()) {
                    cache.recordBadPing(c.id());
                }
            }
            return Ping.BAD_SECRET;
        }
        if (!(k instanceof HookReader reader)) {
            return Ping.NOT_SUPPORTED;
        }
        if (!allow(conn.id(), PER_MINUTE)) {
            return Ping.TOO_MANY;
        }
        List<String> ids = reader.ids(body == null ? "" : body);
        String event = event(body);
        Instant now = clock.instant();
        cache.recordPing(conn.id(), now, event);
        if (!ids.isEmpty()) {
            cache.addWaiting(conn.id(), ids, event, now);
            String id = conn.id();
            if (live.vault().token(id).isPresent()) {
                background.submit(() -> route(id));
            }
        }
        signals.changed(conn.id(), "hook");
        return Ping.ACCEPTED;
    }

    /** The event type only ("workitem.updated"); nothing else of the body is kept. */
    static String event(String body) {
        if (body == null) {
            return null;
        }
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"eventType\"\\s*:\\s*\"([A-Za-z0-9._-]{1,60})\"").matcher(body);
        return m.find() ? m.group(1) : null;
    }

    private boolean allow(String conn, int max) {
        long now = System.currentTimeMillis();
        Deque<Long> q = recent.computeIfAbsent(conn, k -> new ArrayDeque<>());
        synchronized (q) {
            while (!q.isEmpty() && q.peekFirst() < now - 60_000) {
                q.pollFirst();
            }
            if (q.size() >= max) {
                return false;
            }
            q.addLast(now);
            return true;
        }
    }

    @Override
    public void drain(String conn) {
        if (!cache.waiting(conn).isEmpty()) {
            background.submit(() -> route(conn));
        }
    }

    /** The waiting ids go to the boards whose tree or cards hold them (a sync), and every rule of the connection runs. */
    void route(String conn) {
        try {
            List<String> ids = cache.takeWaiting(conn);
            if (ids.isEmpty()) {
                return;
            }
            Set<String> boards = new LinkedHashSet<>();
            for (String id : ids) {
                for (BoardItemRow r : cache.boardsOfItem(conn, id)) {
                    boards.add(r.boardId());
                }
                for (CardLinkRow l : cache.cardLinksOfItem(conn, id)) {
                    if (l.boardId() != null) {
                        boards.add(l.boardId());
                    }
                }
            }
            BoardItemsUseCase bi = boardItems.getIfAvailable();
            if (bi != null) {
                for (String b : boards) {
                    bi.sync(b, true);
                    signals.board(b, conn, "sync", Map.of("source", "hook"));
                }
            }
            WatchRulesUseCase w = rules.getIfAvailable();
            if (w != null) {
                w.runForConnection(conn, "HOOK");
            }
        } catch (TeamException e) {
            log.info("Hook ids of {} not routed: {}", conn, e.code());
        } catch (RuntimeException e) {
            log.warn("Hook ids of {} not routed: {}", conn, e.getClass().getSimpleName());
        }
    }
}
