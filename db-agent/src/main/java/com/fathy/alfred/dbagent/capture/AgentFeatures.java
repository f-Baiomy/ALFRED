package com.fathy.alfred.dbagent.capture;

/**
 * Which capture features this JVM has on (specs/012-server-program: {@code features=} of the agent arguments). An
 * attach can only add instrumentation, never remove it, so turning a feature off is this switch: a call's header may
 * still say {@code db=1}, but with {@link #db} off nothing is recorded for it. All on by default, which is what loading
 * the agent meant before features existed.
 */
public final class AgentFeatures {

    public static volatile boolean db = true;
    public static volatile boolean logs = true;
    public static volatile boolean redis = true;

    private AgentFeatures() {
    }
}
