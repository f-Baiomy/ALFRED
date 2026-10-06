package com.fathy.alfred.dbagent.transport;

/**
 * One log event the agent caught inside the application (specs/009-agent-log-capture, contracts/agent-log-capture.md):
 * attached to its call ({@code callId}, {@code seq} shared with the call's statements and supplier calls), or an
 * outside-call line ({@code callId == null}, {@code seq == 0}).
 */
public final class LogRecord {
    public String callId;
    public int seq;
    /** ISO instant with a fixed 3-digit fraction, so text order is time order. */
    public String at;
    public String level;
    public String logger;
    public String thread;
    public String message;
    public String exceptionType;
    public String exceptionMessage;
    public String exceptionStack;
    /** The line (message + exception) was cut to the per-line cap. */
    public boolean cut;

    public long approxBytes() {
        return 96 + len(level) + len(logger) + len(thread) + len(message) + len(exceptionType) + len(exceptionMessage) + len(exceptionStack);
    }

    private static int len(String s) {
        return s == null ? 0 : s.length() * 2;
    }
}
