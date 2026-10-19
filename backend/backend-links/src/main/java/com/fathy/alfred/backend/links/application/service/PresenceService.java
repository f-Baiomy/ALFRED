package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.PresenceUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Presence;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Presence (D29). On the reader, pages say what they have open; the owner hears only "this Alfred has it open" or "no
 * longer" (counted over every page, sent when the count crosses zero, sent again on reconnect). On the owner, it is
 * kept in memory per link and cleared when the link drops.
 */
@Service
public class PresenceService implements PresenceUseCase {

    private record View(String slug, String target) {
    }

    private record Seen(int viewers, Instant since) {
    }

    private final RelayService relay;
    private final LinksNotificationPort notifications;
    private final Map<String, Set<View>> pages = new ConcurrentHashMap<>();
    private final Map<View, Integer> counts = new HashMap<>();
    private final Map<String, Map<String, Seen>> owner = new ConcurrentHashMap<>();
    private final ExecutorService sender = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "link-presence");
        t.setDaemon(true);
        return t;
    });

    public PresenceService(RelayService relay, LinksNotificationPort notifications) {
        this.relay = relay;
        this.notifications = notifications;
    }

    @PreDestroy
    void stop() {
        sender.shutdownNow();
    }

    // ---------------------------------------------------------------------------------------------- the reader side

    @Override
    public void viewing(String pageId, String slug, String target, boolean on) {
        View v = new View(slug, target);
        boolean cross;
        synchronized (counts) {
            Set<View> views = pages.computeIfAbsent(pageId, k -> ConcurrentHashMap.newKeySet());
            if (on ? !views.add(v) : !views.remove(v)) {
                return;
            }
            int before = counts.getOrDefault(v, 0);
            int after = Math.max(0, before + (on ? 1 : -1));
            if (after == 0) {
                counts.remove(v);
            } else {
                counts.put(v, after);
            }
            cross = (before == 0) != (after == 0);
        }
        if (cross) {
            tell(v, on);
        }
    }

    @Override
    public void pageGone(String pageId) {
        Set<View> views = pages.remove(pageId);
        if (views == null) {
            return;
        }
        List<View> closed = new ArrayList<>();
        synchronized (counts) {
            for (View v : views) {
                int after = counts.getOrDefault(v, 0) - 1;
                if (after <= 0) {
                    counts.remove(v);
                    closed.add(v);
                } else {
                    counts.put(v, after);
                }
            }
        }
        closed.forEach(v -> tell(v, false));
    }

    private void tell(View v, boolean on) {
        sender.execute(() -> {
            try {
                relay.fetch(v.slug(), new RelayRequest("POST", "/links/peer/presence", "", Map.of("Content-Type", "application/json"),
                        Json.write(Map.of("target", v.target(), "on", on)), List.of()), Duration.ofSeconds(10), 64 * 1024);
            } catch (RuntimeException ignored) {
                // offline: said again on reconnect
            }
        });
    }

    /** A link came back: tell it again what this Alfred has open of it. */
    void resend(Link link) {
        List<View> open;
        synchronized (counts) {
            open = counts.keySet().stream().filter(v -> v.slug().equals(link.slug())).toList();
        }
        open.forEach(v -> tell(v, true));
    }

    // ---------------------------------------------------------------------------------------------- the owner side

    void heard(Link from, String target, boolean on) {
        Map<String, Seen> m = owner.computeIfAbsent(from.id(), k -> new ConcurrentHashMap<>());
        if (on) {
            m.putIfAbsent(target, new Seen(1, Instant.now()));
        } else {
            m.remove(target);
        }
        notifications.changed("presence-changed", Json.write(Map.of("linkId", from.id(), "target", target, "on", on)));
    }

    void dropped(String linkId) {
        if (owner.remove(linkId) != null) {
            notifications.changed("presence-changed", Json.write(Map.of("linkId", linkId)));
        }
    }

    @Override
    public List<Presence> presence() {
        List<Presence> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        owner.forEach((linkId, m) -> m.forEach((target, s) -> {
            if (seen.add(linkId + "|" + target)) {
                out.add(new Presence(linkId, target, s.viewers(), s.since()));
            }
        }));
        return out;
    }
}
