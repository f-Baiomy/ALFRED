package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;

import java.util.List;
import java.util.Map;

/** The log lines the agent caught (specs/009-agent-log-capture) - read by the call-logs bridge and the outside view. */
public interface CallLogLinesUseCase {

    int MAX_PAGE = 500;

    /** The agent caught this call's lines - they, not log files, are its lines. */
    boolean caughtFor(String callId);

    /** A call's lines in its own order (seq), after {@code afterSeq}, at most {@code limit} (clamped to {@link #MAX_PAGE}). */
    List<CaughtLogLine> lines(String callId, int afterSeq, int limit);

    Map<String, CaughtLogCounts> counts(List<String> callIds);

    /** Outside-call lines of a project, optionally one thread, oldest first. */
    List<CaughtLogLine> outside(String project, String thread, long afterId, int limit);
}
