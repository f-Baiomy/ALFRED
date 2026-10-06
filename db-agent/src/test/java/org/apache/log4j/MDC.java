package org.apache.log4j;

import java.util.HashMap;
import java.util.Map;

/**
 * A stand-in for log4j 1's MDC (same static API: put(String, Object), get, remove), so LogTaggingIT sees an
 * application logging MDC on the test class path without a logging library. Test sources only - never shaded.
 */
public final class MDC {

    private static final ThreadLocal<Map<String, Object>> VALUES = ThreadLocal.withInitial(HashMap::new);

    private MDC() {
    }

    public static void put(String key, Object value) {
        VALUES.get().put(key, value);
    }

    public static Object get(String key) {
        return VALUES.get().get(key);
    }

    public static void remove(String key) {
        VALUES.get().remove(key);
    }
}
