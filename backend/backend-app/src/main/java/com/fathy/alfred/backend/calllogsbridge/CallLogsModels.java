package com.fathy.alfred.backend.calllogsbridge;

import java.util.List;

/** The wire shapes of `/call-logs` (specs/008-logs-call-link/contracts/call-logs-api.md). */
public final class CallLogsModels {

    private CallLogsModels() {
    }

    public enum Setup { OK, LINKING_OFF, NO_SOURCE, NO_THREAD }

    public enum Match { EXACT, THREAD_TIME }

    /** One log line linked to a call; {@code kept} = served from ALFRED's own copy. */
    public record LinkedLogLine(String sourceId, String sourceName, String lineId, String at, long offsetMs, String level, String thread,
                                String logger, String message, Match matchedBy, boolean kept, String raw) {
    }

    public record CallLogsPage(String callId, Setup setup, Match matchedBy, String thread, int clockSkewMs,
                               List<LinkedLogLine> lines, String next) {
    }

    public record LogCounts(int lines, int errors, int warnings, Match matchedBy) {
    }

    public record LineCall(CallRef call, Match matchedBy) {
    }

    public record CallRef(String id, String method, String url, Integer status, double durationMs, String service, String at) {
    }
}
