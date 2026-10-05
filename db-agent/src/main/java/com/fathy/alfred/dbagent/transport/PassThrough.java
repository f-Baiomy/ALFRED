package com.fathy.alfred.dbagent.transport;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The project's pass-through classes (Settings → Database capture): frames the call chain skips - a generic DAO every
 * query goes through. An entry matches a class by package/class prefix ({@code com.acme.dao.} or
 * {@code com.acme.dao.GenericDAOImpl}) or by its simple name ({@code GenericDAOImpl}). Answers are cached per class.
 */
public final class PassThrough {

    public static final PassThrough NONE = new PassThrough(java.util.Collections.<String>emptyList());
    private static final int CACHE_LIMIT = 8192;

    private final String[] entries;
    private final ConcurrentHashMap<String, Boolean> cache = new ConcurrentHashMap<>();

    public PassThrough(List<String> entries) {
        this.entries = entries.stream().map(String::trim).filter(e -> !e.isEmpty()).toArray(String[]::new);
    }

    public boolean isEmpty() {
        return entries.length == 0;
    }

    public boolean matches(String className) {
        if (entries.length == 0) {
            return false;
        }
        Boolean known = cache.get(className);
        if (known != null) {
            return known;
        }
        String simple = className.substring(className.lastIndexOf('.') + 1);
        int inner = simple.indexOf('$');
        String outer = inner < 0 ? simple : simple.substring(0, inner);
        boolean match = false;
        for (String e : entries) {
            if (className.startsWith(e) || (e.indexOf('.') < 0 && (outer.equals(e) || outer.toLowerCase(Locale.ROOT).equals(e.toLowerCase(Locale.ROOT))))) {
                match = true;
                break;
            }
        }
        if (cache.size() >= CACHE_LIMIT) {
            cache.clear();
        }
        cache.put(className, match);
        return match;
    }

    List<String> asList() {
        return java.util.Arrays.asList(entries);
    }
}
