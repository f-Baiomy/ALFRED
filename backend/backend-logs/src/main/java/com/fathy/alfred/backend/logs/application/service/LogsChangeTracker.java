package com.fathy.alfred.backend.logs.application.service;

import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * A version number per source, bumped by everything that changes what a query returns (lines stored or
 * removed, structure or levels changed, rebuilds), and a small cache of aggregate results keyed by it.
 * The histogram, sidebar counts, minimap and structure counts read every matching line; re-opening or
 * re-rendering an explorer over unchanged data now costs nothing. Results are invalid the moment the
 * version moves, so nothing stale is ever served.
 */
@Component
public class LogsChangeTracker {

    static final int MAX_ENTRIES = 200;

    private final Map<String, AtomicLong> versions = new ConcurrentHashMap<>();
    private final Map<String, Object> cache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Object> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    public void changed(String sourceId) {
        versions.computeIfAbsent(sourceId, k -> new AtomicLong()).incrementAndGet();
    }

    long version(String sourceId) {
        return versions.computeIfAbsent(sourceId, k -> new AtomicLong()).get();
    }

    /** The cached result for (source, kind, key) at the current version, computing it if absent. */
    @SuppressWarnings("unchecked")
    <T> T cached(String sourceId, String kind, Object key, Supplier<T> compute) {
        String k = sourceId + '|' + version(sourceId) + '|' + kind + '|' + key;
        synchronized (cache) {
            Object hit = cache.get(k);
            if (hit != null) {
                return (T) hit;
            }
        }
        T value = compute.get();
        if (value != null) {
            synchronized (cache) {
                cache.put(k, value);
            }
        }
        return value;
    }
}
