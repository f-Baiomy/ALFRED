package com.fathy.alfred.backend.logs.domain.ingest;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Groups similar messages into templates for the Patterns view (FR-026, research §R8) - a small
 * Drain-style miner: tokens with digits become {@code ‹n›}, messages are bucketed by token count
 * and first token, and inside a bucket a message joins the first cluster whose template shares at
 * least {@link #SIMILARITY} of its tokens; differing tokens become {@code ‹*›}.
 *
 * <p>Not thread-safe: one miner per source, used by that source's single ingest/rebuild thread.
 */
public final class PatternMiner {

    static final double SIMILARITY = 0.5;
    /** Messages longer than this many tokens are cut for matching only; the stored line is untouched. */
    private static final int MAX_TOKENS = 64;
    private static final String WILDCARD = "‹*›";
    private static final String NUMBER = "‹n›";

    private final Map<String, List<Cluster>> buckets = new HashMap<>();
    private long nextId;

    public static final class Cluster {
        private final long id;
        private final String[] tokens;
        private boolean changed;

        Cluster(long id, String[] tokens) {
            this.id = id;
            this.tokens = tokens;
        }

        public long id() {
            return id;
        }

        public String template() {
            return String.join(" ", tokens);
        }

        /** True once since the last {@link #clearChanged()} if the template got a new wildcard. */
        public boolean changed() {
            return changed;
        }

        public void clearChanged() {
            changed = false;
        }
    }

    public PatternMiner(long nextId) {
        this.nextId = nextId;
    }

    /** Restores a stored template (ingest resumes with the clusters it already had). */
    public void restore(long id, String template) {
        String[] t = template.isEmpty() ? new String[0] : template.split(" ");
        buckets.computeIfAbsent(key(t), k -> new ArrayList<>()).add(new Cluster(id, t));
        nextId = Math.max(nextId, id + 1);
    }

    public Cluster add(String message) {
        String[] tokens = tokenize(message);
        List<Cluster> bucket = buckets.computeIfAbsent(key(tokens), k -> new ArrayList<>());
        for (Cluster c : bucket) {
            int same = 0;
            for (int i = 0; i < tokens.length; i++) {
                if (c.tokens[i].equals(tokens[i]) || c.tokens[i].equals(WILDCARD)) {
                    same++;
                }
            }
            if (tokens.length == 0 || same >= SIMILARITY * tokens.length) {
                for (int i = 0; i < tokens.length; i++) {
                    if (!c.tokens[i].equals(tokens[i]) && !c.tokens[i].equals(WILDCARD)) {
                        c.tokens[i] = WILDCARD;
                        c.changed = true;
                    }
                }
                return c;
            }
        }
        Cluster c = new Cluster(nextId++, tokens);
        c.changed = true;
        bucket.add(c);
        return c;
    }

    static String[] tokenize(String message) {
        if (message == null || message.isBlank()) {
            return new String[0];
        }
        String[] raw = message.strip().split("\\s+");
        int n = Math.min(raw.length, MAX_TOKENS);
        String[] out = new String[n];
        for (int i = 0; i < n; i++) {
            out[i] = raw[i].chars().anyMatch(Character::isDigit) ? NUMBER : raw[i];
        }
        return out;
    }

    private static String key(String[] tokens) {
        // Bucketing on the first token keeps unrelated messages of the same length apart; a first
        // token that is itself variable (‹n›) still buckets together, which is what we want.
        return tokens.length + "|" + (tokens.length == 0 ? "" : tokens[0]);
    }
}
