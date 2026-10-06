package com.fathy.alfred.backend.calllogsbridge;

import java.util.List;

/** The wire shapes of `/call-logs` (specs/008-logs-call-link/contracts/call-logs-api.md). */
public final class CallLogsModels {

    private CallLogsModels() {
    }

    /** OK: the agent caught the call's lines; LINKING_OFF: ▤ is off for its project; NO_AGENT: ▤ is on but the agent
     *  caught nothing for the call (not attached, an older agent, or the call ran before ▤ was turned on). */
    public enum Setup { OK, LINKING_OFF, NO_AGENT }

    /** EXACT / THREAD_TIME: a log-file line matched to the call (008); CAUGHT: caught by the agent inside the call (009). */
    public enum Match { EXACT, THREAD_TIME, CAUGHT }

    /** An exception a caught line carried, whole (cut only at the agent's per-line cap). */
    public record LogException(String type, String message, String stack) {
    }

    /** One log line linked to a call; {@code kept} = served from ALFRED's own copy; {@code seq} = a caught line's place in the call's own order. */
    public record LinkedLogLine(String sourceId, String sourceName, String lineId, String at, long offsetMs, String level, String thread,
                                String logger, String message, Match matchedBy, boolean kept, String raw, LogException exception, Integer seq) {

        public LinkedLogLine(String sourceId, String sourceName, String lineId, String at, long offsetMs, String level, String thread,
                             String logger, String message, Match matchedBy, boolean kept, String raw) {
            this(sourceId, sourceName, lineId, at, offsetMs, level, thread, logger, message, matchedBy, kept, raw, null, null);
        }
    }

    /**
     * {@code dropped}: lines the agent did not keep for the call (caps, late) - 0 for file lines. {@code logLevel}: the
     * Log level that applied to this call (ERROR by default, APP = the application's own) - lines below it were not caught;
     * {@code levelAssumed} when the call predates per-call levels and the project's current setting is shown instead.
     */
    public record CallLogsPage(String callId, Setup setup, Match matchedBy, String thread, int clockSkewMs,
                               List<LinkedLogLine> lines, String next, int dropped, String logLevel, Boolean levelAssumed) {

        public CallLogsPage(String callId, Setup setup, Match matchedBy, String thread, int clockSkewMs, List<LinkedLogLine> lines, String next,
                            int dropped) {
            this(callId, setup, matchedBy, thread, clockSkewMs, lines, next, dropped, null, null);
        }

        public CallLogsPage(String callId, Setup setup, Match matchedBy, String thread, int clockSkewMs, List<LinkedLogLine> lines, String next) {
            this(callId, setup, matchedBy, thread, clockSkewMs, lines, next, 0);
        }
    }

    public record LogCounts(int lines, int errors, int warnings, Match matchedBy) {
    }

}
