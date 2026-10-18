package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.application.port.in.KeysUseCase;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsNotificationPort;
import com.fathy.alfred.backend.sessions.application.port.out.SessionsStorePort;
import com.fathy.alfred.backend.sessions.domain.Keys;
import com.fathy.alfred.backend.sessions.domain.model.BrowserKey;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.Helper;
import com.fathy.alfred.backend.sessions.domain.model.Issued;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;

/** See {@link KeysUseCase}. Pairing codes live in memory only: a restart voids the open ones. */
@Service
public class KeysService implements KeysUseCase {

    static final Duration CODE_LIFE = Duration.ofMinutes(2);
    static final int CODE_TRIES = 5;
    /** Wrong codes allowed per minute across all browsers, so six digits cannot be walked. */
    static final int WRONG_PER_MINUTE = 30;
    /** last_seen is written at most this often per key, not on every request. */
    static final Duration SEEN_EVERY = Duration.ofMinutes(1);
    static final int MAX_FIELD = 200;

    private final SessionsStorePort store;
    private final SessionsNotificationPort notifications;
    private final ObjectProvider<HoldersUseCase> holders;
    private final Clock clock;

    private record Pending(String helperKeyId, Instant expiresAt, int[] tries) {
    }

    private final Map<String, Pending> codes = new ConcurrentHashMap<>();
    private final Map<String, Instant> seen = new ConcurrentHashMap<>();
    private final List<Instant> wrong = new ArrayList<>();

    @Autowired
    public KeysService(SessionsStorePort store, SessionsNotificationPort notifications, ObjectProvider<HoldersUseCase> holders) {
        this(store, notifications, holders, Clock.systemUTC());
    }

    KeysService(SessionsStorePort store, SessionsNotificationPort notifications, ObjectProvider<HoldersUseCase> holders, Clock clock) {
        this.store = store;
        this.notifications = notifications;
        this.holders = holders;
        this.clock = clock;
    }

    @Override
    public Issued registerHelper(String user, String machine, String claudeAccount, String ip) {
        String u = Keys.user(user);
        String m = clip(machine);
        if (u.isEmpty() || !u.contains("@") || m.isEmpty()) {
            throw new IllegalArgumentException("A helper registers with the user's email and the PC's name");
        }
        Keys.New key = Keys.generate();
        Instant now = clock.instant();
        store.addHelper(new Helper(key.keyId(), clip(u), m, clip(claudeAccount), clip(ip), "{}", now, now, null), key.hash());
        store.revokeHelpersOn(u, m, key.keyId(), now);
        notifications.changed("keys", null);
        return new Issued(key.keyId(), key.key(), u, m);
    }

    @Override
    public Optional<Caller> authenticate(String rawKey) {
        Optional<Keys.Parsed> parsed = Keys.parse(rawKey);
        if (parsed.isEmpty()) {
            return Optional.empty();
        }
        String keyId = parsed.get().keyId();
        Optional<SessionsStorePort.KeyHash> stored = store.keyHash(keyId);
        if (stored.isEmpty() || !Keys.matches(parsed.get().secret(), stored.get().hash())) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        boolean write = seen.compute(keyId, (k, last) -> last == null || last.plus(SEEN_EVERY).isBefore(now) ? now : last) == now;
        if ("helper".equals(stored.get().kind())) {
            Optional<Helper> h = store.helper(keyId);
            if (h.isEmpty() || h.get().revokedAt() != null) {
                return Optional.empty();
            }
            if (write) {
                store.helperSeen(keyId, now, null, null);
            }
            return Optional.of(new Caller(h.get().user(), h.get().machine(), keyId, keyId, Caller.Kind.HELPER));
        }
        Optional<BrowserKey> b = store.browser(keyId);
        if (b.isEmpty() || b.get().revokedAt() != null) {
            return Optional.empty();
        }
        Optional<Helper> paired = store.helper(b.get().helperKeyId());
        if (paired.isEmpty() || paired.get().revokedAt() != null) {
            return Optional.empty();
        }
        if (write) {
            store.browserSeen(keyId, now);
        }
        return Optional.of(new Caller(b.get().user(), paired.get().machine(), keyId, b.get().helperKeyId(), Caller.Kind.BROWSER));
    }

    @Override
    public Helper heartbeat(Caller helper, String ip, String info) {
        requireHelper(helper);
        String body = info == null || info.isBlank() ? "{}" : info;
        if (body.length() > 64 * 1024) {
            throw new IllegalArgumentException("The heartbeat says too much (64 KB at most)");
        }
        Instant now = clock.instant();
        boolean wasOnline = store.helper(helper.keyId()).map(h -> h.online(now)).orElse(false);
        store.helperSeen(helper.keyId(), now, clip(ip), body);
        seen.put(helper.keyId(), now);
        if (!wasOnline) {
            notifications.changed("keys", null);
        }
        return store.helper(helper.keyId()).orElseThrow();
    }

    @Override
    public PairCode pairCode(Caller helper) {
        requireHelper(helper);
        Instant now = clock.instant();
        codes.values().removeIf(p -> p.expiresAt().isBefore(now));
        codes.entrySet().removeIf(e -> e.getValue().helperKeyId().equals(helper.keyId()));
        String code;
        do {
            code = Keys.pairCode();
        } while (codes.containsKey(code));
        Instant expires = now.plus(CODE_LIFE);
        codes.put(code, new Pending(helper.keyId(), expires, new int[]{0}));
        return new PairCode(code, expires);
    }

    @Override
    public synchronized Optional<Issued> pairBrowser(String code, String label) {
        Instant now = clock.instant();
        wrong.removeIf(t -> t.isBefore(now.minusSeconds(60)));
        if (wrong.size() >= WRONG_PER_MINUTE) {
            return Optional.empty();
        }
        String c = code == null ? "" : code.replaceAll("\\s", "");
        Pending p = codes.get(c);
        if (p == null || p.expiresAt().isBefore(now) || p.tries()[0] >= CODE_TRIES) {
            wrong.add(now);
            // a wrong code counts against every open code, so guessing burns them
            codes.values().forEach(x -> x.tries()[0]++);
            codes.values().removeIf(x -> x.tries()[0] >= CODE_TRIES || x.expiresAt().isBefore(now));
            return Optional.empty();
        }
        codes.remove(c);
        Optional<Helper> helper = store.helper(p.helperKeyId());
        if (helper.isEmpty() || helper.get().revokedAt() != null) {
            return Optional.empty();
        }
        Keys.New key = Keys.generate();
        store.addBrowser(new BrowserKey(key.keyId(), helper.get().keyId(), helper.get().user(), clip(label), now, now, null), key.hash());
        notifications.changed("keys", null);
        return Optional.of(new Issued(key.keyId(), key.key(), helper.get().user(), helper.get().machine()));
    }

    @Override
    public Devices devices(Caller caller) {
        return new Devices(store.helpersOf(caller.user()), store.browsersOf(caller.user()));
    }

    @Override
    public boolean revokeOwn(Caller caller, String keyId) {
        boolean mine = store.helper(keyId).map(h -> h.user().equals(caller.user())).orElse(false)
                || store.browser(keyId).map(b -> b.user().equals(caller.user())).orElse(false);
        if (!mine || !store.revoke(keyId, clock.instant())) {
            return false;
        }
        seen.remove(keyId);
        notifications.changed("keys", null);
        return true;
    }

    @Override
    public List<UserLine> users() {
        Map<String, UserLine> out = new LinkedHashMap<>();
        Map<String, TreeSet<String>> machines = new LinkedHashMap<>();
        Map<String, Instant> last = new LinkedHashMap<>();
        for (Helper h : store.allHelpers()) {
            if (h.revokedAt() != null) {
                continue;
            }
            machines.computeIfAbsent(h.user(), k -> new TreeSet<>()).add(h.machine());
            if (h.lastSeen() != null) {
                last.merge(h.user(), h.lastSeen(), (a, b) -> a.isAfter(b) ? a : b);
            }
        }
        for (Map.Entry<String, TreeSet<String>> e : machines.entrySet()) {
            int browsers = (int) store.browsersOf(e.getKey()).stream().filter(b -> b.revokedAt() == null).count();
            out.put(e.getKey(), new UserLine(e.getKey(), List.copyOf(e.getValue()), browsers, last.get(e.getKey())));
        }
        return out.values().stream().sorted(Comparator.comparing(UserLine::user)).toList();
    }

    @Override
    public boolean adminRevoke(String keyId) {
        Optional<String> user = store.helper(keyId).map(Helper::user).or(() -> store.browser(keyId).map(BrowserKey::user));
        if (user.isEmpty() || !store.revoke(keyId, clock.instant())) {
            return false;
        }
        seen.remove(keyId);
        // the user may still hold boards through another live helper; with none left, their boards are freed
        boolean anyLeft = store.helpersOf(user.get()).stream().anyMatch(h -> h.revokedAt() == null);
        HoldersUseCase h = holders.getIfAvailable();
        if (!anyLeft && h != null) {
            h.releaseAllOf(user.get(), "key revoked by the admin");
        }
        notifications.changed("keys", null);
        return true;
    }

    @Override
    public List<Helper> helpersOf(String user) {
        return store.helpersOf(Keys.user(user)).stream().filter(h -> h.revokedAt() == null).toList();
    }

    private static void requireHelper(Caller c) {
        if (c == null || !c.isHelper()) {
            throw new IllegalArgumentException("Only a helper may do this");
        }
    }

    static String clip(String s) {
        if (s == null) {
            return "";
        }
        String v = s.strip().replaceAll("[\\r\\n\\t]", " ");
        return v.length() > MAX_FIELD ? v.substring(0, MAX_FIELD) : v;
    }
}
