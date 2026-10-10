package com.fathy.alfred.backend.storage;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The most disk space Alfred may use, and how it is split. Each share is a RATIO of {@link #bytes}: raise or lower the
 * budget and every limit grows or shrinks with it. {@code bytes == null}: no budget, the separate limits from .env
 * apply as before. The extra rules are per kind: at most N calls (0 = no count limit), keep the last N runs per Relive
 * cycle, and an age limit in days per kind (0 = never).
 */
record StorageBudget(Long bytes, String split, Map<String, Double> ratios, int inboundMaxCalls, int outboundMaxCalls,
                     int reliveKeepRuns, Map<String, Integer> maxAgeDays, Rules rules) {

    /**
     * The page's automatic rules, which apply with or without a budget. {@code dropPreflights}: OPTIONS calls are
     * removed every 10 minutes; {@code healthPaths}: comma-separated URL parts (e.g. /health,/actuator) removed the
     * same way; {@code lowDiskWarnGb}: warn under this much free disk (0 = off); {@code diskGuardGb}: under this much
     * free disk delete the oldest traffic until 5 GB more is free (0 = off); {@code autoCompact}: free the empty space
     * of a file more than 20% empty, nightly; {@code nightlyBackup}: back up your work and setup at 03:00, last 7 kept;
     * {@code stopRecording}: endpoints never recorded again, each "inbound GET /path" or "outbound POST https://host/path"
     * (the URL without its query); {@code keepCommented}: the size and count limits skip a call with a comment.
     */
    record Rules(boolean dropPreflights, String healthPaths, int lowDiskWarnGb, int diskGuardGb, boolean autoCompact,
                 boolean nightlyBackup, List<String> stopRecording, Boolean keepCommented) {
        static final Rules DEFAULT = new Rules(false, "", 10, 2, true, false, List.of(), true);

        Rules(boolean dropPreflights, String healthPaths, int lowDiskWarnGb, int diskGuardGb, boolean autoCompact, boolean nightlyBackup) {
            this(dropPreflights, healthPaths, lowDiskWarnGb, diskGuardGb, autoCompact, nightlyBackup, List.of(), true);
        }

        List<String> stopRecordingOrEmpty() {
            return stopRecording == null ? List.of() : stopRecording;
        }

        /** Missing in a file saved before the rule existed: on, as the page shows it. */
        boolean keepCommentedOrDefault() {
            return keepCommented == null || keepCommented;
        }
    }

    StorageBudget(Long bytes, String split, Map<String, Double> ratios, int inboundMaxCalls, int outboundMaxCalls,
                  int reliveKeepRuns, Map<String, Integer> maxAgeDays) {
        this(bytes, split, ratios, inboundMaxCalls, outboundMaxCalls, reliveKeepRuns, maxAgeDays, Rules.DEFAULT);
    }

    Rules rulesOrDefault() {
        return rules == null ? Rules.DEFAULT : rules;
    }

    /** The shares, in the order the bar shows them. "work" (session cycles, comments, Relive cycles, setup) is never deleted. */
    static final List<String> SHARES = List.of("inbound", "capture", "outbound", "logs", "reliveRuns", "work");

    /** Ages a rule can apply to. */
    static final List<String> AGE_KINDS = List.of("inbound", "outbound", "reliveRuns");

    static final long MIN_BYTES = 1L << 30;
    static final long GB = 1L << 30;

    /** Fits any install: inbound calls are large and frequent, their captures about a fifth of them. */
    static final Map<String, Double> RECOMMENDED = ratios(0.55, 0.20, 0.10, 0.08, 0.02, 0.05);
    static final Map<String, Double> INBOUND_FIRST = ratios(0.60, 0.17, 0.06, 0.10, 0.02, 0.05);
    static final Map<String, Double> OUTBOUND_FIRST = ratios(0.38, 0.12, 0.33, 0.10, 0.02, 0.05);

    static final StorageBudget NONE = new StorageBudget(null, "recommended", RECOMMENDED, 0, 0, 0, Map.of(), Rules.DEFAULT);

    static Map<String, Double> ratios(double inbound, double capture, double outbound, double logs, double reliveRuns, double work) {
        Map<String, Double> map = new LinkedHashMap<>();
        map.put("inbound", inbound);
        map.put("capture", capture);
        map.put("outbound", outbound);
        map.put("logs", logs);
        map.put("reliveRuns", reliveRuns);
        map.put("work", work);
        return Map.copyOf(map);
    }

    boolean isSet() {
        return bytes != null && bytes > 0;
    }

    /** The ratio set this budget uses; custom ratios are scaled to add up to 1. */
    Map<String, Double> effectiveRatios() {
        Map<String, Double> chosen = switch (split == null ? "recommended" : split) {
            case "inbound" -> INBOUND_FIRST;
            case "outbound" -> OUTBOUND_FIRST;
            case "custom", "even" -> ratios == null || ratios.isEmpty() ? RECOMMENDED : ratios;
            default -> RECOMMENDED;
        };
        double sum = SHARES.stream().mapToDouble(k -> Math.max(0, chosen.getOrDefault(k, 0.0))).sum();
        Map<String, Double> out = new LinkedHashMap<>();
        for (String k : SHARES) {
            out.put(k, sum <= 0 ? RECOMMENDED.get(k) : Math.max(0, chosen.getOrDefault(k, 0.0)) / sum);
        }
        return out;
    }

    /** Bytes of each share - 0 for every share while no budget is set. */
    Map<String, Long> shareBytes() {
        Map<String, Long> out = new LinkedHashMap<>();
        Map<String, Double> r = effectiveRatios();
        for (String k : SHARES) {
            out.put(k, isSet() ? (long) Math.floor(bytes * r.get(k)) : 0L);
        }
        return out;
    }

    int ageDays(String kind) {
        return maxAgeDays == null ? 0 : Math.max(0, maxAgeDays.getOrDefault(kind, 0));
    }

    /** Refuses what cannot be applied: a budget under 1 GB, unknown split, a negative rule. */
    StorageBudget validated() {
        if (bytes != null && bytes > 0 && bytes < MIN_BYTES) {
            throw new IllegalArgumentException("The storage budget is at least 1 GB");
        }
        String s = split == null || split.isBlank() ? "recommended" : split;
        if (!List.of("recommended", "even", "inbound", "outbound", "custom").contains(s)) {
            throw new IllegalArgumentException("Unknown split: " + split);
        }
        if (inboundMaxCalls < 0 || outboundMaxCalls < 0 || reliveKeepRuns < 0) {
            throw new IllegalArgumentException("Limits cannot be negative");
        }
        if (("custom".equals(s) || "even".equals(s)) && (ratios == null || ratios.values().stream().anyMatch(v -> v == null || v < 0))) {
            throw new IllegalArgumentException("A custom split needs a ratio for every share");
        }
        Map<String, Integer> ages = new LinkedHashMap<>();
        if (maxAgeDays != null) {
            maxAgeDays.forEach((k, v) -> {
                if (!AGE_KINDS.contains(k)) {
                    throw new IllegalArgumentException("No age rule for " + k);
                }
                if (v != null && v < 0) {
                    throw new IllegalArgumentException("An age rule cannot be negative");
                }
                ages.put(k, v == null ? 0 : v);
            });
        }
        Rules r = rulesOrDefault();
        if (r.lowDiskWarnGb() < 0 || r.diskGuardGb() < 0) {
            throw new IllegalArgumentException("Disk limits cannot be negative");
        }
        String health = r.healthPaths() == null ? "" : r.healthPaths().trim();
        return new StorageBudget(bytes != null && bytes > 0 ? bytes : null, s,
                ratios == null ? Map.of() : Map.copyOf(ratios), inboundMaxCalls, outboundMaxCalls, reliveKeepRuns, Map.copyOf(ages),
                new Rules(r.dropPreflights(), health, r.lowDiskWarnGb(), r.diskGuardGb(), r.autoCompact(), r.nightlyBackup(),
                        r.stopRecordingOrEmpty().stream().map(String::trim).filter(e -> e.matches("(inbound|outbound) [A-Z]+ [^ ]+"))
                                .distinct().toList(), r.keepCommentedOrDefault()));
    }
}
