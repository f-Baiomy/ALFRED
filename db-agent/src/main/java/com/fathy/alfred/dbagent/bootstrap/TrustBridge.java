package com.fathy.alfred.dbagent.bootstrap;

import java.util.function.Predicate;

/**
 * What the trust advice inlined into the JDK's own trust manager reads (TrustManagerAdvice). Like {@link Bridge} it is
 * put on the bootstrap class path, the only place java.base can see, and only JDK types cross it.
 */
public final class TrustBridge {

    /** Accepts a server chain the JDK refused; null while the feature is off. */
    public static volatile Predicate<Object> acceptor;

    private TrustBridge() {
    }

    /** True when the agent accepts a chain the JDK refused. Never throws. */
    public static boolean accepts(Object chain) {
        Predicate<Object> current = acceptor;
        if (current == null) {
            return false;
        }
        try {
            return current.test(chain);
        } catch (Throwable t) {
            return false;
        }
    }
}
