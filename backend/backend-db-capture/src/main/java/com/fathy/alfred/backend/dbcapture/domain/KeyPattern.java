package com.fathy.alfred.backend.dbcapture.domain;

import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * A key with its variable parts as {@code *} (specs/011-redis-capture research R13) - groups commands in the Keys view,
 * findings, endpoint health and comparisons. A segment (split on {@code :}) that is all digits or a hex/uuid token of
 * 8+ characters is variable on its own (the agent's fingerprint uses the same rule); within one call, the last segment
 * also becomes {@code *} when three or more keys share everything before it ({@code fare:rule:EK … fare:rule:CX}).
 */
public final class KeyPattern {

    static final int SIBLINGS = 3;

    private KeyPattern() {
    }

    public static String of(String key) {
        if (key == null) {
            return null;
        }
        String[] parts = key.split(":", -1);
        StringBuilder out = new StringBuilder(key.length());
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) {
                out.append(':');
            }
            out.append(variable(parts[i]) ? "*" : parts[i]);
        }
        return out.toString();
    }

    static boolean variable(String s) {
        if (s.isEmpty()) {
            return false;
        }
        boolean digits = true;
        boolean hex = s.length() >= 8;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            digits &= c >= '0' && c <= '9';
            hex &= (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == '-';
        }
        return digits || hex;
    }

    /** The pattern of each of a call's keys, siblings folded (see class comment). */
    public static Map<String, String> ofAll(Collection<String> keys) {
        Map<String, String> base = new LinkedHashMap<>();
        for (String k : keys) {
            if (k != null) {
                base.put(k, of(k));
            }
        }
        Map<String, Set<String>> lastByPrefix = new HashMap<>();
        for (String p : new HashSet<>(base.values())) {
            int cut = p.lastIndexOf(':');
            if (cut > 0) {
                lastByPrefix.computeIfAbsent(p.substring(0, cut), x -> new HashSet<>()).add(p.substring(cut + 1));
            }
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : base.entrySet()) {
            String p = e.getValue();
            int cut = p.lastIndexOf(':');
            if (cut > 0 && lastByPrefix.getOrDefault(p.substring(0, cut), Set.of()).size() >= SIBLINGS) {
                p = p.substring(0, cut) + ":*";
            }
            out.put(e.getKey(), p);
        }
        return out;
    }
}
