package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchPage;
import com.fathy.alfred.backend.dbcapture.domain.model.LogSearchQuery;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblem;
import com.fathy.alfred.backend.dbcapture.domain.model.LogProblemCall;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;

import java.util.List;
import java.util.Optional;
import java.util.Collection;
import java.util.Map;

/** The log lines the agent caught (specs/009-agent-log-capture) - read by the call-logs bridge and the outside view. */
public interface CallLogLinesUseCase {

    int MAX_PAGE = 500;

    /** The agent caught this call's lines (or they were imported with it). */
    boolean caughtFor(String callId);

    /** A call's lines in its own order (seq), after {@code afterSeq}, at most {@code limit} (clamped to {@link #MAX_PAGE}). */
    List<CaughtLogLine> lines(String callId, int afterSeq, int limit);

    Map<String, CaughtLogCounts> counts(List<String> callIds);

    /** An imported call's lines (.json export), stored with the call like caught lines. */
    void importLines(String callId, List<CaughtLogLine> lines);

    /** Outside-call lines of a project, optionally one thread, oldest first. */
    List<CaughtLogLine> outside(String project, String thread, long afterId, int limit);

    // ---- specs/010-mcp-log-investigation: cross-call reads. scope = the call ids to look at, null = every stored call.

    /** Pattern searches stop after this long (a catastrophic regex must never hold a thread). */
    long PATTERN_BUDGET_MS = 2_000;
    /** ...or after examining this many candidate lines. */
    int PATTERN_MAX_CANDIDATES = 200_000;
    int MAX_PROBLEMS = 100;

    /** Lines matching a text or pattern search, newest first; a bad pattern is an IllegalArgumentException. */
    LogSearchPage search(Collection<String> scope, LogSearchQuery query);

    /** ERROR (and, if asked, WARN) lines grouped into log problems, most lines first, with the number of groups in all. */
    LogProblemsPage problems(Collection<String> scope, boolean withWarnings, Long fromMs, Long toMs, int limit);

    /** The calls that had one log problem, newest first. */
    List<LogProblemCall> problemCalls(Collection<String> scope, String fingerprint, int offset, int limit);

    /** Outside-call lines in a time window at or above a level (null = all), oldest first. */
    List<CaughtLogLine> outside(String project, String thread, long afterId, int limit, Long fromMs, Long toMs, String minLevel);

    /** The Log level that applied when the call was caught (its CALL_OPEN marker), if the agent said. */
    Optional<String> capturedLevel(String callId);

    record LogProblemsPage(List<LogProblem> problems, long groups) {
    }
}
